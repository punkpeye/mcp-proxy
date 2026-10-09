import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

const post = (port: number, body: unknown) =>
  fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

it.each([
  [
    "initialize",
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    },
  ],
  ["non-initialize", { id: 1, jsonrpc: "2.0", method: "ping" }],
])(
  "tears down the per-request server after a stateless %s request",
  async (_name, body) => {
    const port = await getRandomPort();
    const onClose = vi.fn().mockResolvedValue(undefined);

    const httpServer = await startHTTPServer({
      createServer: async () =>
        new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
      modern: false,
      onClose,
      port,
      stateless: true,
    });

    try {
      const response = await post(port, body);

      expect(response.status).toBe(200);

      await response.text();
      await delay(200);

      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await httpServer.close();
    }
  },
);
