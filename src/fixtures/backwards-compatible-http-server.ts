#!/usr/bin/env tsx
/**
 * An upstream HTTP MCP server for the stdio-proxy tests, replacing the
 * `sseAndStreamableHttpCompatibleServer` example that shipped with the v1 SDK.
 *
 * Serves three surfaces from one process:
 *   - `/sse` + `/messages` - the deprecated HTTP+SSE transport (2025 only)
 *   - `/mcp`               - Streamable HTTP, both eras via `createMcpHandler`
 *
 * `PORT` selects the listen port (default 3000).
 */

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest, Server } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const NOTIFICATION_TOOL = {
  description: "Starts sending periodic notifications for testing resumability",
  inputSchema: {
    properties: {
      count: {
        default: 50,
        description: "Number of notifications to send (0 for 100)",
        type: "number",
      },
      interval: {
        default: 100,
        description: "Interval in milliseconds between notifications",
        type: "number",
      },
    },
    type: "object",
  },
  name: "start-notification-stream",
} as const;

const createServer = () => {
  const server = new Server(
    { name: "backwards-compatible-server", version: "1.0.0" },
    { capabilities: { logging: {}, tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [NOTIFICATION_TOOL],
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { count = 50, interval = 100 } = (request.params.arguments ?? {}) as {
      count?: number;
      interval?: number;
    };

    for (let index = 0; index < count; index++) {
      await delay(interval);

      ctx.mcpReq.log("info", `Periodic notification #${index + 1}`);
    }

    return {
      content: [
        {
          text: `Started sending periodic notifications every ${interval}ms`,
          type: "text" as const,
        },
      ],
    };
  });

  return server;
};

const modernHandler = createMcpHandler(() => createServer(), {
  legacy: "stateless",
});
const modernNodeHandler = toNodeHandler(modernHandler);

const sseTransports: Record<string, SSEServerTransport> = {};
const streamTransports: Record<string, NodeStreamableHTTPServerTransport> = {};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);

    sseTransports[transport.sessionId] = transport;

    res.on("close", () => {
      delete sseTransports[transport.sessionId];
    });

    await createServer().connect(transport);

    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const transport = sseTransports[url.searchParams.get("sessionId") ?? ""];

    if (!transport) {
      res.writeHead(400).end("No active transport");

      return;
    }

    await transport.handlePostMessage(req, res);

    return;
  }

  if (url.pathname === "/mcp") {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;

    // Sessionful for 2025-era clients (the shape mcp-proxy itself serves), and
    // `createMcpHandler` for everything carrying a 2026-07-28 envelope.
    if (!(await isLegacyRequest(await toWebRequest(req, body)))) {
      await modernNodeHandler(req, res, body);

      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport = sessionId ? streamTransports[sessionId] : undefined;

    if (!transport) {
      transport = new NodeStreamableHTTPServerTransport({
        onsessioninitialized: (id) => {
          streamTransports[id] = transport!;
        },
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      await createServer().connect(transport);
    }

    await transport.handleRequest(req, res, body);

    return;
  }

  res.writeHead(404).end();
});

const port = Number(process.env.PORT ?? 3000);

httpServer.listen(port, () => {
  // The stdio-proxy test waits for this line before connecting.
  console.log(`Backwards compatible MCP server listening on port ${port}`);
});
