import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "./createGracefulShutdown.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("runs the teardown once and never drops a rejected close when two signals arrive", async () => {
  // Regression test: SIGTERM and SIGINT both invoke the shutdown handler and
  // there was no re-entrancy guard, so a second signal (Ctrl-C then SIGTERM)
  // called `server.close()` again. The SDK rejects the redundant close, and
  // because the promise was dropped it surfaced as an unhandledRejection that
  // crashed the shutdown with a non-zero exit.
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  // Capture the registered handlers instead of emitting real process signals,
  // which would tear down the test runner.
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, "once").mockImplementation(
    (event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), handler as () => void);
      return process;
    },
  );

  let closeCalls = 0;
  const close = vi.fn(async () => {
    closeCalls += 1;

    if (closeCalls > 1) {
      // Mirrors the SDK closing an already-closing server.
      throw new Error("Server is not running.");
    }
  });

  try {
    createGracefulShutdown({ server: { close }, timeout: 5_000 });

    const sigint = handlers.get("SIGINT");
    const sigterm = handlers.get("SIGTERM");
    expect(sigint).toBeDefined();
    expect(sigterm).toBeDefined();

    // Two signals arriving close together, e.g. Ctrl-C followed by SIGTERM.
    sigint?.();
    sigterm?.();

    // Give any dropped rejection a chance to surface.
    await delay(100);

    expect(close).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toEqual([]);
  } finally {
    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

it("reports a failing close via console.error instead of leaving it unhandled", async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  const handlers = new Map<string, () => void>();
  vi.spyOn(process, "once").mockImplementation(
    (event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), handler as () => void);
      return process;
    },
  );

  const closeError = new Error("close failed");
  const close = vi.fn(async () => {
    throw closeError;
  });

  try {
    createGracefulShutdown({ server: { close }, timeout: 5_000 });

    handlers.get("SIGTERM")?.();

    await delay(100);

    expect(consoleError).toHaveBeenCalledWith(
      "[mcp-proxy] error during shutdown",
      closeError,
    );
    expect(unhandledRejections).toEqual([]);
  } finally {
    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
