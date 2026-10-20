import {
  JSONRPCMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/client";
import { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

import { StdioClientTransport } from "./StdioClientTransport.js";

/**
 * Reaches for the child process the transport keeps private, so the test can
 * watch the stdin stream the send path writes to.
 */
const childOf = (transport: StdioClientTransport): ChildProcess =>
  (transport as unknown as { _process: ChildProcess })._process;

/**
 * Never reads stdin, so the pipe backs up and write() returns false - the only
 * situation the buffered-send path applies to.
 */
const DEAF_CHILD = ["-e", "setTimeout(() => {}, 60000)"];

const startTransport = async (args: string[]) => {
  const transport = new StdioClientTransport({
    args,
    command: "node",
    env: process.env as Record<string, string>,
    stderr: "ignore",
  });

  await transport.start();

  return transport;
};

const messageOfSize = (id: number, bytes: number): JSONRPCMessage => ({
  id,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: { blob: "x".repeat(bytes) }, name: "noop" },
});

it("settles pending sends when the child exits before the write drains", async () => {
  // Regression test: send() resolved on "drain" and nothing else. A child
  // that stops reading stdin makes write() return false, and if that child
  // then dies the "drain" event never arrives - so the promise stayed pending
  // forever and its "drain" listener stayed attached, one per stuck send.
  const transport = await startTransport(DEAF_CHILD);

  const child = childOf(transport);
  const stdin = child.stdin!;
  // spawn() attaches its own "exit" listener for the abort signal, so the
  // interesting number is the delta, not the absolute count.
  const exitListenersBefore = child.listenerCount("exit");

  const outcomes = [1, 2, 3].map((id) =>
    transport.send(messageOfSize(id, 1024 * 1024)).then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
  );

  // Precondition: every write was buffered rather than flushed, which is the
  // only situation the bug applies to. The promise executor runs
  // synchronously, so the listeners are already attached here.
  expect(stdin.writableLength).toBeGreaterThan(0);
  expect(stdin.listenerCount("drain")).toBe(3);

  process.kill(transport.pid!, "SIGKILL");

  const settled = await Promise.race([
    Promise.all(outcomes),
    delay(2_000).then(() => "still pending" as const),
  ]);

  expect(settled).toEqual(["rejected", "rejected", "rejected"]);
  expect(stdin.listenerCount("drain")).toBe(0);
  // Killing the child races several events, and the one that settles the sends
  // first decides whether spawn's own "exit" listener has fired and removed
  // itself by now. Only the upper bound is stable, and it is the half that
  // catches the leak this test is about.
  expect(child.listenerCount("exit")).toBeLessThanOrEqual(exitListenersBefore);

  await transport.close();
}, 10_000);

it("fires close exactly once when the transport is closed", async () => {
  // Regression test (#86): close() emitted the {type:"close"} event and then
  // aborted the child. The abort tripped both child handlers - the "error"
  // handler on AbortError and the "close" handler - and each fired onclose (and
  // the second also re-emitted the close event). So a plain start()/close()
  // delivered onclose twice and {type:"close"} twice. A single guard collapses
  // all three paths to one notification.
  const closeEvents: number[] = [];
  const transport = new StdioClientTransport({
    args: ["-e", "setTimeout(() => {}, 60000)"],
    command: "node",
    env: process.env as Record<string, string>,
    onEvent: (event) => {
      if (event.type === "close") {
        closeEvents.push(1);
      }
    },
    stderr: "ignore",
  });

  let oncloseCount = 0;
  transport.onclose = () => {
    oncloseCount += 1;
  };

  await transport.start();
  await transport.close();

  // The child's "close"/"error" handlers land on a later tick than close()
  // returns, so give them room to fire before counting. Without the guard this
  // is where the second onclose and the second close event arrive.
  await delay(200);

  expect(oncloseCount).toBe(1);
  expect(closeEvents).toHaveLength(1);
}, 10_000);

it("settles a pending send when the transport is closed", async () => {
  // The same hang on the ordinary shutdown path: close() aborts the child, so
  // a write that has not drained yet can never complete.
  const transport = await startTransport(DEAF_CHILD);

  const stdin = childOf(transport).stdin!;

  const outcome = transport.send(messageOfSize(1, 1024 * 1024)).then(
    () => "resolved" as const,
    () => "rejected" as const,
  );

  expect(stdin.listenerCount("drain")).toBe(1);

  await transport.close();

  await expect(
    Promise.race([outcome, delay(2_000).then(() => "still pending" as const)]),
  ).resolves.toBe("rejected");
  expect(stdin.listenerCount("drain")).toBe(0);
}, 10_000);

it("rejects a pending send with the error stdin reports", async () => {
  // A real broken pipe races stdin's "error" and "close" against the child's
  // "exit", so any one of the three can settle the send and none of them is
  // pinned by the tests above. Each is emitted directly below instead. This
  // branch is the one that has to surface the reported error as-is.
  const transport = await startTransport(DEAF_CHILD);

  const stdin = childOf(transport).stdin!;
  const closeListenersBefore = stdin.listenerCount("close");
  const pipeError = new Error("write EPIPE");

  const outcome = transport.send(messageOfSize(1, 1024 * 1024)).then(
    () => "resolved",
    (error: Error) => error,
  );

  expect(stdin.listenerCount("drain")).toBe(1);

  stdin.emit("error", pipeError);

  await expect(outcome).resolves.toBe(pipeError);
  expect(stdin.listenerCount("drain")).toBe(0);
  expect(stdin.listenerCount("close")).toBe(closeListenersBefore);

  await transport.close();
}, 10_000);

it("rejects a pending send when stdin closes", async () => {
  const transport = await startTransport(DEAF_CHILD);

  const stdin = childOf(transport).stdin!;
  // start() keeps an "error" listener on stdin for the transport's lifetime.
  const errorListenersBefore = stdin.listenerCount("error");

  const outcome = transport.send(messageOfSize(1, 1024 * 1024)).then(
    () => "resolved",
    (error: Error) => error.message,
  );

  expect(stdin.listenerCount("drain")).toBe(1);

  stdin.emit("close");

  await expect(outcome).resolves.toBe(
    "Stdin closed before the message was sent",
  );
  expect(stdin.listenerCount("drain")).toBe(0);
  expect(stdin.listenerCount("close")).toBe(0);
  expect(stdin.listenerCount("error")).toBe(errorListenersBefore);

  await transport.close();
}, 10_000);

it("rejects a pending send when the child reports it has exited", async () => {
  const transport = await startTransport(DEAF_CHILD);

  const child = childOf(transport);
  const stdin = child.stdin!;
  const pid = transport.pid!;
  const errorListenersBefore = stdin.listenerCount("error");

  const outcome = transport.send(messageOfSize(1, 1024 * 1024)).then(
    () => "resolved",
    (error: Error) => error.message,
  );

  expect(stdin.listenerCount("drain")).toBe(1);

  child.emit("exit", null, "SIGTERM");

  await expect(outcome).resolves.toBe(
    "Child process exited before the message was sent",
  );
  expect(stdin.listenerCount("drain")).toBe(0);
  expect(stdin.listenerCount("close")).toBe(0);
  expect(stdin.listenerCount("error")).toBe(errorListenersBefore);

  // The synthetic "exit" made spawn() drop its abort-signal listener, so
  // close() can no longer reap the child. Kill it directly instead.
  process.kill(pid, "SIGKILL");
}, 10_000);

it("closes the connection when a message is over the read buffer cap", async () => {
  // Regression test: `ReadBuffer.append` throws once a message exceeds its cap.
  // Thrown straight out of the transform's "data" listener, that throw
  // destroyed the transform the child's stdout is piped into, so every later
  // message was dropped and onclose never fired - the connection went
  // permanently deaf instead of failing, and in-flight requests could only end
  // in a timeout.
  const oversized = 11 * 1024 * 1024;
  const transport = await startTransport([
    "-e",
    `process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"pad":"' + 'X'.repeat(${oversized}) + '"}}\\n');` +
      `setInterval(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\\n"), 100);`,
  ]);

  const errors: string[] = [];
  const closed = new Promise<"closed">((resolve) => {
    transport.onclose = () => resolve("closed");
  });
  transport.onerror = (error) => errors.push(error.message);

  await expect(
    Promise.race([closed, delay(5_000).then(() => "still open" as const)]),
  ).resolves.toBe("closed");
  expect(errors[0]).toMatch(/ReadBuffer exceeded maximum size/);

  await transport.close();
}, 15_000);

it("reports an error on the child's stdout instead of crashing the process", async () => {
  // Regression test: `pipe()` does not forward a source error to its
  // destination, so the handler on the transform never saw one and the child's
  // read end had no "error" listener at all. An error there - "read
  // ECONNRESET" when a child dies abruptly - was an "error" event with no
  // listener, which EventEmitter rethrows and which therefore took the whole
  // proxy process down.
  const transport = await startTransport(DEAF_CHILD);

  const stdout = childOf(transport).stdout!;
  const readError = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });

  expect(stdout.listenerCount("error")).toBe(1);

  const reported = new Promise<Error>((resolve) => {
    transport.onerror = resolve;
  });

  stdout.emit("error", readError);

  await expect(reported).resolves.toBe(readError);

  await transport.close();
}, 10_000);

it("resolves send() and leaves no listeners behind once a buffered write drains", async () => {
  // The happy path for the same code: a child that does read stdin lets the
  // buffered write flush, so "drain" arrives and the promise resolves - and
  // the listeners added for the failure paths must be removed too. The child
  // outlives the send here, so spawn's "exit" listener is still in place and
  // the count has to land back exactly on the baseline.
  const transport = await startTransport([
    "-e",
    "process.stdin.resume(); setTimeout(() => {}, 60000)",
  ]);

  const child = childOf(transport);
  const stdin = child.stdin!;
  const exitListenersBefore = child.listenerCount("exit");

  const send = transport.send(messageOfSize(1, 1024 * 1024));

  expect(stdin.listenerCount("drain")).toBe(1);

  await expect(send).resolves.toBeUndefined();

  expect(stdin.listenerCount("drain")).toBe(0);
  expect(child.listenerCount("exit")).toBe(exitListenersBefore);

  await transport.close();
}, 10_000);

it("closes the connection when the JSON filter exceeds its buffer cap", async () => {
  const transport = new StdioClientTransport({
    args: [
      "-e",
      `process.stdout.write(Buffer.alloc(${2 * STDIO_DEFAULT_MAX_BUFFER_SIZE + 1}, 120)); setInterval(() => {}, 1000);`,
    ],
    command: "node",
    env: process.env as Record<string, string>,
    stderr: "ignore",
  });
  let closeCount = 0;
  transport.onclose = () => {
    closeCount++;
  };
  const reported = new Promise<Error>((resolve) => {
    transport.onerror = resolve;
  });
  let exited: Promise<void> | undefined;

  try {
    await transport.start();
    exited = new Promise((resolve) => {
      childOf(transport).once("close", () => resolve());
    });
    const error = await reported;
    expect(error.message).toMatch(
      /JSONFilterTransform buffer exceeded maximum size/,
    );
    expect(closeCount).toBe(1);
    expect(transport.pid).toBeNull();
    await exited;
    expect(closeCount).toBe(1);
  } finally {
    await transport.close();
    await exited;
  }
}, 15_000);
