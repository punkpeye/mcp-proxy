#!/usr/bin/env tsx
/**
 * A stdio server served through `serveStdio`, which picks the protocol era
 * from the opening exchange. Used to prove the proxy can front a 2026-07-28
 * upstream as well as a 2025-era one.
 *
 * `MCP_FIXTURE_LEGACY=reject` refuses 2025-era openings, so a test can assert
 * the proxy really negotiated the modern era rather than quietly falling back.
 */

import { Server, Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(
  ({ era }) => {
    const server = new Server(
      {
        name: "dual-era-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: { listChanged: true, subscribe: true },
          tools: { listChanged: true },
        },
      },
    );

    const tools: Tool[] = [
      {
        description: "Reports the era it was served from",
        inputSchema: { properties: {}, type: "object" },
        name: "whoami",
      },
      {
        description: "Emits notifications/tools/list_changed",
        inputSchema: { properties: {}, type: "object" },
        name: "trigger-list-changed",
      },
      {
        description: "Emits notifications/resources/updated for a URI",
        inputSchema: {
          properties: { uri: { type: "string" } },
          required: ["uri"],
          type: "object",
        },
        name: "trigger-resource-updated",
      },
    ];

    server.setRequestHandler("tools/list", async () => ({ tools }));

    server.setRequestHandler("resources/subscribe", async () => ({}));
    server.setRequestHandler("resources/unsubscribe", async () => ({}));

    server.setRequestHandler("tools/call", async (request) => {
      if (request.params.name === "trigger-list-changed") {
        await server.notification({
          method: "notifications/tools/list_changed",
        });

        return { content: [{ text: "notified", type: "text" as const }] };
      }

      if (request.params.name === "trigger-resource-updated") {
        await server.notification({
          method: "notifications/resources/updated",
          params: { uri: String(request.params.arguments?.uri) },
        });

        return { content: [{ text: "notified", type: "text" as const }] };
      }

      return {
        content: [{ text: `served from the ${era} era`, type: "text" as const }],
      };
    });

    server.setRequestHandler("resources/list", async () => ({
      resources: [{ name: "Example Resource", uri: "file:///example.txt" }],
    }));

    server.setRequestHandler("resources/read", async (request) => ({
      contents: [
        {
          mimeType: "text/plain",
          text: "This is the content of the example resource.",
          uri: request.params.uri,
        },
      ],
    }));

    return server;
  },
  {
    legacy: process.env.MCP_FIXTURE_LEGACY === "reject" ? "reject" : "serve",
  },
);
