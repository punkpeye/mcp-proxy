import { McpServer, Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { afterEach, expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

/**
 * Regression for #96: the 2026-07-28 (modern) leg crashes when `createServer`
 * returns a server built by the 1.x MCP SDK (e.g. fastmcp <=4.x, which pins
 * `mcp-proxy` `^6.4.6`). Such a server never sets `_supportedProtocolVersions`,
 * so the modern SDK handler throws `Cannot read properties of undefined
 * (reading 'includes')` inside `installDiscoverHandler` before the session is
 * usable. Legacy-handshake clients keep working, so this only shows up against
 * real modern (Claude) traffic in production.
 *
 * A 1.x server is duck-typed here by taking a real 2.x `Server` and removing
 * the property the modern SDK route dereferences - the narrowest faithful stand
 * in for "the instance cannot serve the modern route".
 */

const running: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
  vi.restoreAllMocks();
});

const makeLegacyEraServer = (): Server => {
  const server = new Server(
    { name: "legacy-sdk-server", version: "1.0.0" },
    { capabilities: {} },
  );

  // Simulate a server built by the 1.x SDK: the property the 2026-07-28 route
  // reads is simply absent.
  delete (server as unknown as { _supportedProtocolVersions?: unknown })
    ._supportedProtocolVersions;

  return server;
};

const MODERN_PROTOCOL_VERSION = "2026-07-28";

// The high-level API: `createServer` hands back an `McpServer`, whose inner
// `.server` is what the SDK dereferences. The guard must let this through - the
// wrapper never declares `_supportedProtocolVersions` itself.
const makeHighLevelServer = (): McpServer => {
  const server = new McpServer(
    { name: "high-level-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "ping",
    { description: "ping", inputSchema: {} },
    async () => ({ content: [{ text: "pong", type: "text" as const }] }),
  );

  return server;
};

// A request that mcp-proxy classifies as modern: a JSON-RPC request whose
// params carry the required 2026-07-28 `_meta` envelope, with the matching
// MCP-Protocol-Version header.
const modernRequest = (port: number) =>
  fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      // Required on 2026-07-28 Streamable HTTP POSTs; without it the SDK
      // rejects on the header/body cross-check before reaching the crash.
      "Mcp-Method": "tools/list",
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    },
    method: "POST",
  });

it("does not crash the modern leg when createServer returns a 1.x-SDK server (#96)", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const port = await getRandomPort();
  const httpServer = await startHTTPServer({
    createServer: async () => makeLegacyEraServer(),
    port,
  });
  running.push(httpServer);

  const response = await modernRequest(port);
  const text = await response.text();

  // The SDK's `installDiscoverHandler` TypeError must never be reached: it would
  // surface through the modern handler's `onerror` as a logged error.
  const sawSdkCrash = errorSpy.mock.calls.some((call) =>
    call.some(
      (arg) =>
        arg instanceof TypeError &&
        /Cannot read properties of undefined \(reading 'includes'\)/.test(
          arg.message,
        ),
    ),
  );
  expect(sawSdkCrash, "modern handler crashed inside the SDK").toBe(false);

  // The request must be answered gracefully rather than 500ing the session.
  expect(response.status).not.toBe(500);
  expect(response.status).toBe(400);

  // A graceful refusal is a JSON-RPC error object, not an opaque 500 body.
  const body = JSON.parse(text) as {
    error?: { code?: number; message?: string };
    id?: unknown;
    jsonrpc?: string;
  };
  expect(body.jsonrpc).toBe("2.0");
  expect(body.id).toBe(1);
  expect(body.error).toBeDefined();
  expect(body.error?.message).toMatch(/unsupported protocol version/i);
});

it("still serves the modern leg when createServer returns an McpServer", async () => {
  // The guard must key off the object `serveModern` actually dereferences. It
  // unwraps `McpServer` to its inner `.server`, so judging the wrapper - which
  // never declares `_supportedProtocolVersions` - would refuse every consumer
  // on the SDK's high-level API, turning a crash fix into a total outage.
  const port = await getRandomPort();
  const httpServer = await startHTTPServer({
    createServer: async () => makeHighLevelServer(),
    port,
  });
  running.push(httpServer);

  const response = await modernRequest(port);
  const body = (await response.json()) as {
    result?: { tools?: Array<{ name: string }> };
  };

  expect(response.status).toBe(200);
  expect(body.result?.tools?.map((tool) => tool.name)).toEqual(["ping"]);
});
