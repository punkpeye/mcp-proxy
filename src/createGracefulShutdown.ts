import { setTimeout } from "node:timers";

import { type SSEServer } from "./startHTTPServer.js";

export const createGracefulShutdown = ({
  server,
  timeout,
}: {
  server: Pick<SSEServer, "close">;
  timeout: number;
}) => {
  // Both SIGTERM and SIGINT run `gracefulShutdown`, and the returned callback
  // is a third caller. `server.close()` is a promise that rejects when the
  // server is already closing, so a second invocation - Ctrl-C followed by
  // SIGTERM, or a signal after the manual callback - would drop a rejected
  // promise and crash the process on `unhandledRejection`. This flag makes the
  // teardown run exactly once, and `closeServer` never leaves its promise
  // unhandled.
  let shuttingDown = false;

  const closeServer = () => {
    void server.close().catch((error: unknown) => {
      console.error("[mcp-proxy] error during shutdown", error);
    });
  };

  const gracefulShutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    console.info("received shutdown signal; shutting down");

    closeServer();

    setTimeout(() => {
      // Exit with non-zero code to indicate failure to shutdown gracefully
      process.exit(1);
    }, timeout).unref();
  };

  process.once("SIGTERM", gracefulShutdown);
  process.once("SIGINT", gracefulShutdown);

  return () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    closeServer();
  };
};
