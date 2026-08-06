#!/usr/bin/env tsx
/**
 * A test fixture that simulates a slow MCP server for testing timeout functionality.
 * This server intentionally delays responses to test timeout behavior.
 */

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { setTimeout as delay } from "node:timers/promises";

const server = new Server(
  {
    name: "slow-test-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// Configure delay via environment variable or default to 2 seconds
const RESPONSE_DELAY = parseInt(process.env.RESPONSE_DELAY || "2000", 10);

server.setRequestHandler("resources/list", async () => {
  await delay(RESPONSE_DELAY);
  return {
    resources: [
      {
        name: "Slow Resource",
        uri: "file:///slow.txt",
      },
    ],
  };
});

server.setRequestHandler("resources/read", async ({ params }) => {
  await delay(RESPONSE_DELAY);
  return {
    contents: [
      {
        text: `Content from slow server after ${RESPONSE_DELAY}ms delay`,
        uri: params.uri,
      },
    ],
  };
});

server.setRequestHandler("tools/list", async () => {
  await delay(RESPONSE_DELAY);
  return {
    tools: [
      {
        description: "A slow test tool",
        inputSchema: {
          properties: {
            input: {
              type: "string",
            },
          },
          type: "object",
        },
        name: "slowTool",
      },
    ],
  };
});

server.setRequestHandler("tools/call", async ({ params }) => {
  await delay(RESPONSE_DELAY);
  return {
    content: [
      {
        text: `Tool response after ${RESPONSE_DELAY}ms delay: ${params.arguments?.input}`,
        type: "text" as const,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
