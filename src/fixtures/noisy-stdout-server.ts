#!/usr/bin/env tsx
/**
 * Simulates a Python-like MCP server that emits non-JSON output to stdout
 * before and during startup. This mimics the behavior of Python servers
 * where warnings, import messages, or unbuffered print() calls can
 * pollute the stdout stream that mcp-proxy reads as JSON-RPC.
 *
 * Related: https://github.com/punkpeye/mcp-proxy/issues/55
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Simulate non-JSON output on stdout before the server starts,
// like Python import warnings or startup messages
const noiseBefore = process.env.NOISE_BEFORE;
if (noiseBefore) {
  process.stdout.write(noiseBefore);
}

const server = new Server(
  {
    name: "noisy-stdout-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Simulate noise interleaved with normal responses
  const noiseDuring = process.env.NOISE_DURING;
  if (noiseDuring) {
    process.stdout.write(noiseDuring);
  }

  return {
    tools: [
      {
        description: "A test tool",
        inputSchema: {
          properties: {},
          type: "object",
        },
        name: "ping",
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async () => {
  return {
    content: [
      {
        text: "pong",
        type: "text" as const,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
