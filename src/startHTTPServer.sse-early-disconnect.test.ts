import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

it("cleans up a legacy SSE session whose client left while createServer was pending", async () => {
  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () => {
      await delay(300);

      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    onClose,
    port,
  });

  try {
    const request = http.get(`http://localhost:${port}/sse`);
    request.on("error", () => {});

    await delay(100);
    request.destroy();

    await delay(800);

    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await httpServer.close();
  }
});
