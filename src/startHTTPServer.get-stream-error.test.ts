import * as nodeTransportModule from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

// Regression: the GET branch of handleStreamRequest (the standalone SSE stream
// used for reconnection / Last-Event-ID replay) awaited transport.handleRequest
// without a try/catch, unlike the POST and DELETE branches. The request listener
// handed to http.createServer is async and its promise is never awaited, so a
// rejection from the standalone GET stream surfaced as an unhandled rejection
// (killing the process) and left the request hanging. The catch now settles the
// response, mirroring the POST and DELETE guards in this file.
it("does not crash when the standalone GET stream error path runs after headers are sent", async () => {
  const port = await getRandomPort();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const original =
    nodeTransportModule.NodeStreamableHTTPServerTransport.prototype
      .handleRequest;

  // Let the POST initialize run for real so a stateful session is registered,
  // but make the standalone GET stream flush SSE headers and then throw - the
  // exact shape of a mid-replay failure for a reconnecting client.
  vi.spyOn(
    nodeTransportModule.NodeStreamableHTTPServerTransport.prototype,
    "handleRequest",
  ).mockImplementation(async function (
    this: unknown,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    ...rest: unknown[]
  ) {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      throw new Error("simulated standalone GET stream failure after headers");
    }

    return (original as (...args: unknown[]) => Promise<void>).call(
      this,
      req,
      res,
      ...rest,
    );
  });

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    port,
  });

  try {
    const initializeResponse = await fetch(`http://localhost:${port}/mcp`, {
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

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initializeResponse.text();

    // Reconnecting standalone GET stream that fails mid-replay.
    const streamResponse = await fetch(`http://localhost:${port}/mcp`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": "bogus-event-id",
        "mcp-session-id": sessionId!,
      },
      method: "GET",
    });

    // Headers were already flushed, so the client sees a streamed 200 that ends.
    expect(streamResponse.status).toBe(200);
    await streamResponse.text().catch(() => undefined);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    await delay(100);

    // The crux: the post-headers error path on the GET stream must not produce
    // an unhandled rejection.
    expect(unhandledRejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    consoleError.mockRestore();
    vi.restoreAllMocks();
    await httpServer.close();
  }
});
