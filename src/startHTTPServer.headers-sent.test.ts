import * as nodeTransportModule from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

// Regression: the POST branch of handleStreamRequest called res.writeHead(...) in
// its catch without checking res.headersSent. transport.handleRequest streams the
// response (headers already flushed) before some failures, so a throw after that
// point made writeHead raise ERR_HTTP_HEADERS_SENT, rejecting the request listener
// and killing the process on the unhandled rejection. The catch now bails when the
// response is already committed, mirroring the DELETE and SSE guards in this file.
it("does not crash when the stream POST error path runs after headers are sent", async () => {
  const port = await getRandomPort();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  // Make the transport flush response headers, then throw — the exact shape of a
  // mid-stream failure.
  const handleRequestSpy = vi
    .spyOn(nodeTransportModule.NodeStreamableHTTPServerTransport.prototype, "handleRequest")
    .mockImplementation(async function (
        this: unknown,
        _req: unknown,
        res: import("node:http").ServerResponse,
      ) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      throw new Error("simulated mid-stream failure after headers");
    });

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    port,
    stateless: true,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "hs", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

    // Headers were already sent by the transport, so we get a streamed 200.
    expect(response.status).toBe(200);
    await response.text().catch(() => undefined);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    await delay(100);

    // The crux: the post-headers error path must not produce an unhandled rejection.
    expect(unhandledRejections).toEqual([]);
  } finally {
    handleRequestSpy.mockRestore();
    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
    await httpServer.close();
  }
}, 15_000);
