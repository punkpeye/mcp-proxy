import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import http from "node:http";
import { expect, it } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

it("routes the legacy SSE message POST even when onUnhandledRequest answers unknown paths", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    // A catch-all, like fastmcp's: it assumes it runs after the MCP handlers.
    onUnhandledRequest: async (_req, res) => {
      res.writeHead(404).end("custom-404");
    },
    port,
  });

  let sseRequest: http.ClientRequest | undefined;

  try {
    const sessionEndpoint = await new Promise<string>((resolve, reject) => {
      const request = http.get(`http://localhost:${port}/sse`, (res) => {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const match = /data: (\/messages\?sessionId=[^\s]+)/.exec(buffer);
          if (match) {
            sseRequest = request;
            resolve(match[1]);
          }
        });
      });
      request.on("error", () => {});
      setTimeout(() => reject(new Error("no endpoint event")), 3000);
    });

    const response = await fetch(`http://localhost:${port}${sessionEndpoint}`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(await response.text()).not.toBe("custom-404");
  } finally {
    sseRequest?.destroy();
    await httpServer.close();
  }
});
