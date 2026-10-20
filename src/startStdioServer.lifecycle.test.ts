import { Server } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { expect, it } from "vitest";

const waitForMessage = (child: ChildProcess) =>
  new Promise<unknown>((resolve, reject) => {
    const finish = (error?: Error, message?: unknown) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = (message: unknown) => finish(undefined, message);
    const onExit = () =>
      finish(new Error("Proxy exited before its IPC response"));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for proxy IPC")),
      10_000,
    );
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
it("closes its owned upstream SSE connection when the stdio server closes", async () => {
  const upstream = new Server(
    { name: "upstream", version: "1" },
    { capabilities: {} },
  );
  let transport: SSEServerTransport;
  let resolveClosed: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const httpServer = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.on("close", () => resolveClosed());
      transport = new SSEServerTransport("/messages", response);
      await upstream.connect(transport);
    } else {
      await transport.handlePostMessage(request, response);
    }
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  // A child isolates real process stdin/stdout and can always be reaped even
  // when the regression leaves its internally-created upstream client open.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { startStdioServer, ServerType } from './src/startStdioServer.ts';
    const server = await startStdioServer({ serverType: ServerType.SSE, url: ${JSON.stringify(`http://127.0.0.1:${address.port}/sse`)} });
    process.on('message', async () => {
      await server.close();
      process.send('closed');
    });
    process.send('ready');
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let timeout: NodeJS.Timeout | undefined;

  try {
    expect(await waitForMessage(child)).toBe("ready");
    const closed = waitForMessage(child);
    child.send("close");
    expect(await closed).toBe("closed");
    await expect(
      Promise.race([
        upstreamClosed.then(() => "closed"),
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve("still open"), 1_000);
        }),
      ]),
    ).resolves.toBe("closed");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await exited;
    await upstream.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}, 30_000);
