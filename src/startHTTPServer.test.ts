import { Client } from "@modelcontextprotocol/client";
import { SSEClientTransport } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import { ServerCapabilities } from "@modelcontextprotocol/server";
import { EventSource } from "eventsource";
import fs from "fs";
import { getRandomPort } from "get-port-please";
import http from "http";
import https from "https";
import net from "net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { getBody, startHTTPServer } from "./startHTTPServer.js";

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

it("proxies messages between HTTP stream and stdio servers", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const onConnect = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn().mockResolvedValue(undefined);

  await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    onClose,
    onConnect,
    port,
  });

  const streamClient = new Client(
    {
      name: "stream-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  await streamClient.connect(transport);

  const result = await streamClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  expect(
    await streamClient.readResource({ uri: result.resources[0].uri }, {}),
  ).toEqual({
    contents: [
      {
        mimeType: "text/plain",
        text: "This is the content of the example resource.",
        uri: "file:///example.txt",
      },
    ],
  });
  expect(await streamClient.subscribeResource({ uri: "xyz" })).toEqual({});
  expect(await streamClient.unsubscribeResource({ uri: "xyz" })).toEqual({});
  expect(await streamClient.listResourceTemplates()).toEqual({
    resourceTemplates: [
      {
        description: "Specify the filename to retrieve",
        name: "Example resource template",
        uriTemplate: `file://{filename}`,
      },
    ],
  });

  expect(onConnect).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  // the transport no requires the function terminateSession to be called but the client does not implement it
  // so we need to call it manually
  await transport.terminateSession();
  await streamClient.close();

  await delay(1000);

  expect(onClose).toHaveBeenCalled();
});

it(
  "keeps stateful HTTP stream sessions alive after idle keep-alive timeout window",
  async () => {
    const port = await getRandomPort();
    const onClose = vi.fn().mockResolvedValue(undefined);

    const httpServer = await startHTTPServer({
      createServer: async () => {
        return new Server(
          { name: "test", version: "1.0.0" },
          { capabilities: {} },
        );
      },
      onClose,
      port,
    });

    const initializeResponse = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initializeResponse.text();

    await delay(6_000);

    const listToolsResponse = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "mcp-session-id": sessionId!,
      },
      method: "POST",
    });
    const listToolsBody = await listToolsResponse.text();

    expect(listToolsResponse.status).not.toBe(404);
    expect(listToolsBody).not.toContain("Session not found");
    expect(onClose).not.toHaveBeenCalled();

    await httpServer.close();
  },
  15_000,
);

it("proxies messages between SSE and stdio servers", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const onConnect = vi.fn();
  const onClose = vi.fn();

  await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    onClose,
    onConnect,
    port,
  });

  const sseClient = new Client(
    {
      name: "sse-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  const transport = new SSEClientTransport(
    new URL(`http://localhost:${port}/sse`),
  );

  await sseClient.connect(transport);

  const result = await sseClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  expect(
    await sseClient.readResource({ uri: result.resources[0].uri }, {}),
  ).toEqual({
    contents: [
      {
        mimeType: "text/plain",
        text: "This is the content of the example resource.",
        uri: "file:///example.txt",
      },
    ],
  });
  expect(await sseClient.subscribeResource({ uri: "xyz" })).toEqual({});
  expect(await sseClient.unsubscribeResource({ uri: "xyz" })).toEqual({});
  expect(await sseClient.listResourceTemplates()).toEqual({
    resourceTemplates: [
      {
        description: "Specify the filename to retrieve",
        name: "Example resource template",
        uriTemplate: `file://{filename}`,
      },
    ],
  });

  expect(onConnect).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await sseClient.close();

  await delay(100);

  expect(onClose).toHaveBeenCalled();
});

it("supports stateless HTTP streamable transport", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const onConnect = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    onClose,
    onConnect,
    port,
    stateless: true, // Enable stateless mode
  });

  // Create a stateless streamable HTTP client
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  const streamClient = new Client(
    {
      name: "stream-client-stateless",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await streamClient.connect(streamTransport);

  // Test that we can still make requests in stateless mode
  const result = await streamClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();

  expect(onConnect).toHaveBeenCalled();
  // Note: in stateless mode, onClose behavior may differ since there's no persistent session
  await delay(100);
});

it("allows requests when no auth is configured", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    // No apiKey configured
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
  });

  const streamClient = new Client(
    {
      name: "stream-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Connect without any authentication header
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  await streamClient.connect(transport);

  // Should be able to make requests without auth
  const result = await streamClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("rejects requests without API key when auth is enabled", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    apiKey: "test-api-key-123", // API key configured
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
  });

  // Try to connect without authentication header
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  const streamClient = new Client(
    {
      name: "stream-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Connection should fail due to missing auth
  await expect(streamClient.connect(transport)).rejects.toThrow();

  await httpServer.close();
  await stdioClient.close();
});

it("accepts requests with valid API key", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();
  const apiKey = "test-api-key-123";

  const httpServer = await startHTTPServer({
    apiKey,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
  });

  // Connect with proper authentication header
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          "X-API-Key": apiKey,
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await streamClient.connect(transport);

  // Should be able to make requests with valid auth
  const result = await streamClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("works with SSE transport and authentication", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();
  const apiKey = "test-api-key-456";

  const httpServer = await startHTTPServer({
    apiKey,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
  });

  // Connect with proper authentication header for SSE
  const transport = new SSEClientTransport(
    new URL(`http://localhost:${port}/sse`),
    {
      requestInit: {
        headers: {
          "X-API-Key": apiKey,
        },
      },
    },
  );

  const sseClient = new Client(
    {
      name: "sse-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await sseClient.connect(transport);

  // Should be able to make requests with valid auth
  const result = await sseClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  await sseClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("does not require auth for /ping endpoint", async () => {
  const port = await getRandomPort();
  const apiKey = "test-api-key-789";

  const httpServer = await startHTTPServer({
    apiKey,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test /ping without auth header
  const response = await fetch(`http://localhost:${port}/ping`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");

  await httpServer.close();
});

it("responds with 400 to a malformed request target instead of crashing", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server({ name: "test", version: "1.0.0" }, { capabilities: {} });
    },
    port,
  });

  // `//` is not a valid URL target; sent via http.request so it isn't
  // normalized away. Before the fix this threw inside the request listener
  // and crashed the process.
  const statusCode = await new Promise<number>((resolve, reject) => {
    const request = http.request(
      { host: "localhost", path: "//", port },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });

  expect(statusCode).toBe(400);

  await httpServer.close();
});

it("does not require auth for OPTIONS requests", async () => {
  const port = await getRandomPort();
  const apiKey = "test-api-key-999";

  const httpServer = await startHTTPServer({
    apiKey,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS without auth header
  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: "OPTIONS",
  });
  expect(response.status).toBe(204);

  await httpServer.close();
});

it("allows onUnhandledRequest to serve routes without auth", async () => {
  const port = await getRandomPort();
  const apiKey = "test-api-key-unhandled";

  const httpServer = await startHTTPServer({
    apiKey,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    onUnhandledRequest: async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200).end("ok");
      } else if (req.url === "/ready") {
        res.writeHead(200).end("ready");
      }
      // Don't write response for unknown paths — fall through to MCP handlers
    },
    port,
  });

  // /health works without auth
  const healthResponse = await fetch(`http://localhost:${port}/health`);
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.text()).toBe("ok");

  // /ready works without auth
  const readyResponse = await fetch(`http://localhost:${port}/ready`);
  expect(readyResponse.status).toBe(200);
  expect(await readyResponse.text()).toBe("ready");

  // POST /mcp without auth still returns 401
  const mcpResponse = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  expect(mcpResponse.status).toBe(401);

  await httpServer.close();
});

it("routes MCP stream endpoint to handleStreamRequest even when onUnhandledRequest closes response for unknown paths", async () => {
  // Regression test for the interaction between PR #59 and consumers
  // (e.g. fastmcp) whose onUnhandledRequest handler writes 404 for any path
  // it doesn't recognise. Before the fix, the POST /mcp request was served
  // by onUnhandledRequest (→ 404) and never reached handleStreamRequest.
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    // Simulates fastmcp's handleUnhandledRequest: consumes unknown paths
    // with a 404 because it assumes it runs *after* the MCP protocol handlers.
    onUnhandledRequest: async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200).end("ok");
        return;
      }
      res.writeHead(404).end();
    },
    port,
  });

  // Sanity: custom route still works (preserves PR #59 behaviour).
  const healthResponse = await fetch(`http://localhost:${port}/health`);
  expect(healthResponse.status).toBe(200);

  // The MCP initialize call must reach handleStreamRequest, NOT the 404
  // fallback inside onUnhandledRequest.
  const mcpResponse = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(mcpResponse.status).toBe(200);
  expect(mcpResponse.headers.get("mcp-session-id")).toBeTruthy();

  await httpServer.close();
});

// Stateless OAuth 2.0 JWT Bearer Token Authentication Tests (PR #37)

it("accepts requests with valid Bearer token in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback that validates JWT Bearer token
  const mockAuthResult = { email: "test@example.com", userId: "user123" };
  const authenticate = vi.fn().mockResolvedValue(mockAuthResult);

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true, // Enable stateless mode
  });

  // Create a stateless streamable HTTP client with Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer valid-jwt-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-oauth",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await streamClient.connect(streamTransport);

  // Test that we can make requests with valid authentication
  const result = await streamClient.listResources();
  expect(result).toEqual({
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  });

  // Verify authenticate callback was called
  expect(authenticate).toHaveBeenCalled();

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("returns 401 for authenticated stream requests without a session ID", async () => {
  const port = await getRandomPort();
  const authenticate = vi.fn().mockResolvedValue({ userId: "test-user" });
  const createServer = vi.fn(async () => {
    return new Server({ name: "test", version: "1.0.0" }, { capabilities: {} });
  });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer,
    port,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);

    const errorResponse = (await response.json()) as {
      error: { code: number; message: string };
      id: null | number;
      jsonrpc: string;
    };
    expect(errorResponse.error).toEqual({
      code: -32000,
      message: "Unauthorized: No valid session ID provided",
    });
    expect(errorResponse.id).toBe(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(createServer).not.toHaveBeenCalled();
  } finally {
    await httpServer.close();
  }
});

it("returns 401 for authenticated stream GET requests without a session ID", async () => {
  const port = await getRandomPort();
  const authenticate = vi.fn().mockResolvedValue({ userId: "test-user" });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    port,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer valid-token",
      },
      method: "GET",
    });

    expect(response.status).toBe(401);

    const errorResponse = (await response.json()) as {
      error: { code: number; message: string };
      id: null | number;
      jsonrpc: string;
    };
    expect(errorResponse.error.message).toBe(
      "Unauthorized: No valid session ID provided",
    );
    expect(errorResponse.id).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    await httpServer.close();
  }
});

it("keeps malformed authenticated stream requests as 400", async () => {
  const port = await getRandomPort();
  const authenticate = vi.fn().mockResolvedValue({ userId: "test-user" });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    port,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({ malformed: true }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);

    const errorResponse = (await response.json()) as {
      error: { code: number; message: string };
      id: null | number;
      jsonrpc: string;
    };
    expect(errorResponse.error.message).toBe(
      "Bad Request: No valid session ID provided",
    );
    expect(authenticate).toHaveBeenCalledTimes(1);
  } finally {
    await httpServer.close();
  }
});

it("returns 401 when authenticate callback returns null in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback that rejects invalid token
  const authenticate = vi.fn().mockResolvedValue(null);

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true,
  });

  // Create client with invalid Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer invalid-jwt-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-invalid-token",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Connection should fail due to invalid authentication
  await expect(streamClient.connect(streamTransport)).rejects.toThrow();

  // Verify authenticate callback was called
  expect(authenticate).toHaveBeenCalled();

  await httpServer.close();
  await stdioClient.close();
});

it("returns 401 when authenticate callback throws error in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback that throws (e.g., JWKS endpoint failure)
  const authenticate = vi
    .fn()
    .mockRejectedValue(new Error("JWKS fetch failed"));

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true,
  });

  // Create client with Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer some-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-auth-error",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Connection should fail due to authentication error
  await expect(streamClient.connect(streamTransport)).rejects.toThrow();

  // Verify authenticate callback was called
  expect(authenticate).toHaveBeenCalled();

  await httpServer.close();
  await stdioClient.close();
});

it("calls authenticate on every request in stateful mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback
  const authenticate = vi.fn().mockResolvedValue({ userId: "user123" });

  const onConnect = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    onClose,
    onConnect,
    port,
    stateless: false, // Explicitly use stateful mode
  });

  // Create client
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  const streamClient = new Client(
    {
      name: "stream-client-stateful",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await streamClient.connect(streamTransport);

  const initialCallCount = authenticate.mock.calls.length;

  // Make first request
  await streamClient.listResources();

  // Make second request
  await streamClient.listResources();

  // In stateful mode, authenticate should be called on every request
  // to ensure tokens are validated and not expired
  expect(authenticate.mock.calls.length).toBeGreaterThan(initialCallCount);

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("calls authenticate on every request in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback
  const authenticate = vi.fn().mockResolvedValue({ userId: "user123" });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true, // Enable stateless mode
  });

  // Create client with Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-per-request",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await streamClient.connect(streamTransport);

  const initialCallCount = authenticate.mock.calls.length;

  // Make first request
  await streamClient.listResources();
  const firstRequestCallCount = authenticate.mock.calls.length;

  // Make second request
  await streamClient.listResources();
  const secondRequestCallCount = authenticate.mock.calls.length;

  // In stateless mode, authenticate should be called on EVERY request
  expect(firstRequestCallCount).toBeGreaterThan(initialCallCount);
  expect(secondRequestCallCount).toBeGreaterThan(firstRequestCallCount);

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

it("includes Authorization in CORS allowed headers", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request to verify CORS headers
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);

  // Verify Authorization is in the allowed headers
  const allowedHeaders = response.headers.get("Access-Control-Allow-Headers");
  expect(allowedHeaders).toBeTruthy();
  expect(allowedHeaders).toContain("Authorization");

  await httpServer.close();
});

// Tests for FastMCP-style authentication with { authenticated: false } pattern

it("returns 401 when authenticate callback returns { authenticated: false } in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback that returns { authenticated: false }
  const authenticate = vi.fn().mockResolvedValue({
    authenticated: false,
    error: "Invalid JWT token",
  });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true,
  });

  // Create client with invalid Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer invalid-jwt-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-auth-false",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Connection should fail due to authentication returning false
  await expect(streamClient.connect(streamTransport)).rejects.toThrow();

  // Verify authenticate callback was called
  expect(authenticate).toHaveBeenCalled();

  await httpServer.close();
  await stdioClient.close();
});

it("returns 401 with custom error message when { authenticated: false, error: '...' }", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const customErrorMessage = "Token expired at 2025-10-06T12:00:00Z";

  // Mock authenticate callback with custom error message
  const authenticate = vi.fn().mockResolvedValue({
    authenticated: false,
    error: customErrorMessage,
  });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true,
  });

  // Make request directly with fetch to check error message
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer expired-token",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const errorResponse = (await response.json()) as {
    error: { code: number; message: string };
    id: null | number;
    jsonrpc: string;
  };
  expect(errorResponse.error.message).toBe(customErrorMessage);

  await httpServer.close();
  await stdioClient.close();
});

it("returns 401 when createServer throws authentication error", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const port = await getRandomPort();

  // Mock authenticate that passes, but createServer throws auth error
  const authenticate = vi.fn().mockResolvedValue({
    authenticated: true,
    session: { userId: "test" },
  });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      // Simulate FastMCP throwing error for authenticated: false
      throw new Error("Authentication failed: Invalid JWT payload");
    },
    port,
    stateless: true,
  });

  // Make request
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const errorResponse = (await response.json()) as {
    error: { code: number; message: string };
    id: null | number;
    jsonrpc: string;
  };
  expect(errorResponse.error.message).toContain("Authentication failed");

  await httpServer.close();
  await stdioClient.close();
});

it("returns 401 when createServer throws JWT-related error", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Invalid JWT signature");
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const errorResponse = (await response.json()) as {
    error: { code: number; message: string };
    id: null | number;
    jsonrpc: string;
  };
  expect(errorResponse.error.message).toContain("Invalid JWT");

  await httpServer.close();
});

it("returns 401 when createServer throws Token-related error", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Token has been revoked");
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const errorResponse = (await response.json()) as {
    error: { code: number; message: string };
    id: null | number;
    jsonrpc: string;
  };
  expect(errorResponse.error.message).toContain("Token");

  await httpServer.close();
});

it("returns 401 when createServer throws Unauthorized error", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Unauthorized access");
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const errorResponse = (await response.json()) as {
    error: { code: number; message: string };
    id: null | number;
    jsonrpc: string;
  };
  expect(errorResponse.error.message).toContain("Unauthorized");

  await httpServer.close();
});

it("returns 500 when createServer throws non-auth error", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Database connection failed");
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(500);

  await httpServer.close();
});

it("includes WWW-Authenticate header in 401 response with OAuth config", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Invalid JWT token");
    },
    oauth: {
      protectedResource: {
        resource: "https://example.com",
      },
      realm: "mcp-server",
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const wwwAuthHeader = response.headers.get("WWW-Authenticate");
  expect(wwwAuthHeader).toBeTruthy();
  expect(wwwAuthHeader).toContain("Bearer");
  expect(wwwAuthHeader).toContain('realm="mcp-server"');
  expect(wwwAuthHeader).toContain(
    'resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
  );
  expect(wwwAuthHeader).toContain('error="invalid_token"');
  expect(wwwAuthHeader).toContain('error_description="Invalid JWT token"');

  await httpServer.close();
});

it("includes WWW-Authenticate header when authenticate callback fails with OAuth", async () => {
  const port = await getRandomPort();

  const authenticate = vi
    .fn()
    .mockRejectedValue(new Error("Token signature verification failed"));

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    oauth: {
      error_uri: "https://example.com/docs/errors",
      protectedResource: {
        resource: "https://api.example.com",
      },
      realm: "example-api",
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer expired-token",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);
  expect(authenticate).toHaveBeenCalled();

  const wwwAuthHeader = response.headers.get("WWW-Authenticate");
  expect(wwwAuthHeader).toBeTruthy();
  expect(wwwAuthHeader).toContain("Bearer");
  expect(wwwAuthHeader).toContain('realm="example-api"');
  expect(wwwAuthHeader).toContain(
    'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
  );
  expect(wwwAuthHeader).toContain('error="invalid_token"');
  expect(wwwAuthHeader).toContain(
    'error_description="Token signature verification failed"',
  );
  expect(wwwAuthHeader).toContain(
    'error_uri="https://example.com/docs/errors"',
  );

  await httpServer.close();
});

it("does not include WWW-Authenticate header in 401 response without OAuth config", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      throw new Error("Authentication required");
    },
    port,
    stateless: true,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2024-11-05",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(401);

  const wwwAuthHeader = response.headers.get("WWW-Authenticate");
  expect(wwwAuthHeader).toBeNull();

  await httpServer.close();
});

it("succeeds when authenticate returns { authenticated: true } in stateless mode", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  // Mock authenticate callback that returns { authenticated: true }
  const authenticate = vi.fn().mockResolvedValue({
    authenticated: true,
    session: { email: "test@example.com", userId: "user123" },
  });

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    stateless: true,
  });

  // Create client with valid Bearer token
  const streamTransport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer valid-jwt-token",
        },
      },
    },
  );

  const streamClient = new Client(
    {
      name: "stream-client-auth-true",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  // Should connect successfully
  await streamClient.connect(streamTransport);

  // Should be able to make requests
  const result = await streamClient.listResources();
  expect(result.resources).toBeDefined();

  // Verify authenticate callback was called
  expect(authenticate).toHaveBeenCalled();

  await streamClient.close();
  await httpServer.close();
  await stdioClient.close();
});

// CORS Configuration Tests

it("supports wildcard CORS headers", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: {
      allowedHeaders: "*",
    },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request to verify CORS headers
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);

  // Verify wildcard is used for allowed headers
  const allowedHeaders = response.headers.get("Access-Control-Allow-Headers");
  expect(allowedHeaders).toBe("*");

  await httpServer.close();
});

it("supports custom CORS headers array", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: {
      allowedHeaders: ["Content-Type", "X-Custom-Header", "X-API-Key"],
    },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request to verify CORS headers
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);

  // Verify custom headers are used
  const allowedHeaders = response.headers.get("Access-Control-Allow-Headers");
  expect(allowedHeaders).toBe("Content-Type, X-Custom-Header, X-API-Key");

  await httpServer.close();
});

it("supports origin validation with array", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: {
      origin: ["https://app.example.com", "https://admin.example.com"],
    },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test with allowed origin
  const response1 = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://app.example.com",
    },
    method: "OPTIONS",
  });

  expect(response1.status).toBe(204);
  expect(response1.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://app.example.com",
  );

  // Test with disallowed origin
  const response2 = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://malicious.com",
    },
    method: "OPTIONS",
  });

  expect(response2.status).toBe(204);
  expect(response2.headers.get("Access-Control-Allow-Origin")).toBeNull();

  await httpServer.close();
});

it("supports origin validation with function", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: {
      origin: (origin: string) => origin.endsWith(".example.com"),
    },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test with allowed origin
  const response1 = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://subdomain.example.com",
    },
    method: "OPTIONS",
  });

  expect(response1.status).toBe(204);
  expect(response1.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://subdomain.example.com",
  );

  // Test with disallowed origin
  const response2 = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://malicious.com",
    },
    method: "OPTIONS",
  });

  expect(response2.status).toBe(204);
  expect(response2.headers.get("Access-Control-Allow-Origin")).toBeNull();

  await httpServer.close();
});

it("disables CORS when cors: false", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: false,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request - should not have CORS headers
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();

  await httpServer.close();
});

it("uses default CORS settings when cors: true", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: true,
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request to verify default CORS headers
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id, Mcp-Method, Mcp-Name",
  );
  // The default `credentials: true` is deliberately not emitted alongside the
  // wildcard - see the dedicated test below.
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();

  await httpServer.close();
});

it("never combines wildcard origin with credentials (Fetch Standard forbids it)", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    // No `cors` option passed at all - the actual default path, not `cors: true`.
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      "Access-Control-Request-Method": "POST",
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);

  // https://fetch.spec.whatwg.org/#http-access-control-allow-credentials -
  // a browser rejects the whole CORS response if these two ever appear
  // together, silently failing every credentialed request. The wildcard stays
  // and the credentials header drops, rather than the reverse: reflecting the
  // request origin back would hand any origin a working credentialed grant.
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(response.headers.get("Vary")).toBe("Origin");

  await httpServer.close();
});

it("still sends credentials when an explicit origin allow-list matches", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: { credentials: true, origin: ["https://app.example"] },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  const allowed = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      "Access-Control-Request-Method": "POST",
      Origin: "https://app.example",
    },
    method: "OPTIONS",
  });

  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://app.example",
  );
  expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");

  // A rejected origin still varies by `Origin`, so a shared cache cannot serve
  // this answer to the allowed one.
  const rejected = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      "Access-Control-Request-Method": "POST",
      Origin: "https://evil.example",
    },
    method: "OPTIONS",
  });

  expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(rejected.headers.get("Vary")).toBe("Origin");

  await httpServer.close();
});

it("supports custom methods and maxAge", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    cors: {
      maxAge: 86400,
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
  });

  // Test OPTIONS request to verify custom settings
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: {
      Origin: "https://example.com",
    },
    method: "OPTIONS",
  });

  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
    "GET, POST, PUT, DELETE",
  );
  expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");

  await httpServer.close();
});

// SSL Tests

it("supports creating an SSL server", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
      return mcpServer;
    },
    port,
    sslCert: "src/fixtures/certs/server-cert.pem",
    sslKey: "src/fixtures/certs/server-key.pem",
  });

  const options = {
    ca: fs.readFileSync("src/fixtures/certs/ca-cert.pem"),
    cert: fs.readFileSync("src/fixtures/certs/client-cert.pem"),
    hostname: "localhost",
    key: fs.readFileSync("src/fixtures/certs/client-key.pem"),
    method: "GET",
    path: "/ping",
    port,
  };

  // Use https.get to test client certificate authentication
  // (Node's fetch API doesn't support custom HTTPS agents with client certs)
  const response = await new Promise<{ statusCode?: number; text: string }>(
    (resolve, reject) => {
      https
        .get(options, (res) => {
          let data = "";

          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            resolve({ statusCode: res.statusCode, text: data });
          });

          res.on("error", (err) => {
            reject(err);
          });
        })
        .on("error", (err) => {
          reject(err);
        });
    },
  );

  expect(response.statusCode).toBe(200);
  expect(response.text).toBe("pong");

  await httpServer.close();
});

it("DELETE request terminates session cleanly and calls onClose exactly once", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    { name: "mcp-proxy", version: "1.0.0" },
    { capabilities: {} },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };
  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);
  const onConnect = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });
      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });
      return mcpServer;
    },
    onClose,
    onConnect,
    port,
  });

  const streamClient = new Client(
    { name: "stream-client", version: "1.0.0" },
    { capabilities: {} },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );

  await streamClient.connect(transport);

  // Verify the session works
  const result = await streamClient.listResources();
  expect(result.resources).toHaveLength(1);

  expect(onConnect).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  // Send DELETE to terminate the session — this should not cause ECONNRESET
  await transport.terminateSession();
  await streamClient.close();

  await delay(500);

  // onClose should be called exactly once, not twice
  expect(onClose).toHaveBeenCalledTimes(1);

  await httpServer.close();
  await stdioClient.close();
}, 15000);

it("DELETE request to non-existent session returns 400", async () => {
  const stdioTransport = new StdioClientTransport({
    args: ["src/fixtures/simple-stdio-server.ts"],
    command: "tsx",
  });

  const stdioClient = new Client(
    { name: "mcp-proxy", version: "1.0.0" },
    { capabilities: {} },
  );

  await stdioClient.connect(stdioTransport);

  const serverVersion = stdioClient.getServerVersion() as {
    name: string;
    version: string;
  };
  const serverCapabilities = stdioClient.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });
      await proxyServer({
        client: stdioClient,
        server: mcpServer,
        serverCapabilities,
      });
      return mcpServer;
    },
    port,
  });

  // Send DELETE with a fake session ID
  const response = await new Promise<{ statusCode: number; text: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          headers: {
            "mcp-session-id": "non-existent-session-id",
          },
          hostname: "localhost",
          method: "DELETE",
          path: "/mcp",
          port,
        },
        (res) => {
          let text = "";
          res.on("data", (chunk: Buffer) => {
            text += chunk.toString();
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode!, text });
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

  expect(response.statusCode).toBe(400);

  await httpServer.close();
  await stdioClient.close();
}, 15000);

// The SDK only writes a resumability "priming event" (an `id: <eventId>`
// SSE line) when an event store is configured, so its presence/absence is a
// reliable, wire-level signal of whether resumability is actually active -
// see https://github.com/punkpeye/mcp-proxy/issues/72.
const initializeAndGetRawBody = async (port: number) => {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        // Priming events are only sent to clients whose negotiated protocol
        // version is >= 2025-11-25.
        protocolVersion: "2025-11-25",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  expect(response.status).toBe(200);

  return response.text();
};

it("disables the resumability event store when eventStore: false is passed", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    eventStore: false,
    port,
  });

  try {
    const body = await initializeAndGetRawBody(port);

    expect(body).not.toMatch(/^id: /m);
  } finally {
    await httpServer.close();
  }
});

it("enables a bounded, per-session resumability event store by default", async () => {
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    port,
  });

  try {
    const body = await initializeAndGetRawBody(port);

    expect(body).toMatch(/^id: /m);
  } finally {
    await httpServer.close();
  }
});

it("does not crash when the SSE connect error path runs after headers are sent", async () => {
  // Regression test: the catch block of the SSE connect path called
  // res.writeHead(500) without checking res.headersSent. When the failure
  // happened after the SSE stream was established (headers already sent),
  // writeHead threw ERR_HTTP_HEADERS_SENT, the request listener rejected,
  // and the process died on the unhandled rejection.
  const port = await getRandomPort();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    // server.connect() and the initial transport.send() succeed, so the
    // SSE 200 headers are already on the wire when this throws.
    onConnect: async () => {
      throw new Error("simulated connect failure");
    },
    port,
  });

  try {
    const response = await fetch(`http://localhost:${port}/sse`);
    expect(response.status).toBe(200);

    // Wait until the error path has run, then give any rejection a tick.
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "[mcp-proxy] error connecting to server",
        expect.any(Error),
      );
    });
    await delay(100);

    expect(unhandledRejections).toEqual([]);
  } finally {
    await httpServer.close();
    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

it("handles a client aborting the stream request mid-body instead of hanging", async () => {
  // Regression test: getBody() only settled on "end". A client that stops
  // transmitting mid-body (here: FIN after a partial JSON payload with a
  // larger declared Content-Length) left the promise pending forever, so the
  // request handler never got past `await getBody(...)`.
  //
  // What is asserted is that the handler *resumes*, observed through the
  // `authenticate` hook, which runs on the statement immediately after that
  // await. Asserting on the "error reading body" log would pass for the wrong
  // reason: the string only exists in the fixed code, so it fails without the
  // fix whether or not the promise ever settles, and it would keep passing if
  // a later refactor logged without settling.
  const port = await getRandomPort();

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  let authenticateCalled = false;

  const httpServer = await startHTTPServer({
    authenticate: async () => {
      authenticateCalled = true;

      return { authenticated: true };
    },
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    port,
  });

  try {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "localhost", () => {
        socket.end(
          "POST /mcp HTTP/1.1\r\n" +
            `Host: localhost:${port}\r\n` +
            "Content-Type: application/json\r\n" +
            "Content-Length: 1000\r\n" +
            "\r\n" +
            '{"jsonrpc":"2.0",',
        );
      });
      // Drain the response so the socket can close (an unread reply would
      // otherwise keep "close" from firing). The server tears the
      // connection down after the truncated body; either event means it is
      // done with this connection.
      socket.on("data", () => {});
      socket.on("error", resolve);
      socket.on("close", resolve);
    });

    // The aborted body must settle getBody() (as an invalid body) instead of
    // leaving the request handler pending forever.
    await vi.waitFor(
      () => {
        expect(authenticateCalled).toBe(true);
      },
      { timeout: 2_000 },
    );
  } finally {
    await httpServer.close();
    consoleError.mockRestore();
  }
}, 3_000);

/**
 * Speaks HTTP over a raw socket and returns everything the server wrote back.
 * The oversize paths destroy the connection, so `fetch` would surface them as
 * an opaque network error rather than a status line.
 */
const collectRawResponse = (
  port: number,
  write: (socket: net.Socket) => void,
) =>
  new Promise<string>((resolve) => {
    const received: Buffer[] = [];
    const socket = net.connect(port, "localhost", () => write(socket));

    socket.on("data", (chunk) => received.push(chunk));

    const onDone = () => resolve(Buffer.concat(received).toString());

    socket.on("close", onDone);
    // ECONNRESET once the server tears the connection down is expected.
    socket.on("error", onDone);
  });

it("answers 413 without reading the body when Content-Length exceeds the cap", async () => {
  // The declared size is enough to reject on: no body is sent at all here, so
  // a server that waited to count bytes would never answer.
  const port = await getRandomPort();

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const maxBodySize = 4_096;

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    maxBodySize,
    port,
  });

  try {
    const response = await collectRawResponse(port, (socket) => {
      socket.write(
        "POST /mcp HTTP/1.1\r\n" +
          `Host: localhost:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${maxBodySize * 4}\r\n` +
          "\r\n",
      );
    });

    expect(response).toContain("HTTP/1.1 413");
    expect(response).toContain("Payload Too Large");

    // The server survived and keeps serving other requests.
    const pingResponse = await fetch(`http://localhost:${port}/ping`);
    expect(pingResponse.status).toBe(200);
  } finally {
    await httpServer.close();
    consoleError.mockRestore();
  }
}, 10_000);

it("answers 413 when a chunked body grows past the cap", async () => {
  // A chunked body declares no size up front, so only the streaming byte
  // count can catch it. getBody() previously accumulated every chunk with no
  // bound, letting a dripping client grow the buffer indefinitely.
  const port = await getRandomPort();

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const maxBodySize = 262_144; // 256 KiB, well under the 10 MiB default

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    maxBodySize,
    port,
  });

  try {
    const chunk = Buffer.alloc(65_536, "x");

    const response = await collectRawResponse(port, (socket) => {
      socket.write(
        "POST /mcp HTTP/1.1\r\n" +
          `Host: localhost:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "\r\n",
      );

      // Drip chunks until the server cuts us off. Five times the cap is sent
      // if it never does, which fails the assertion below.
      let sent = 0;
      const timer = setInterval(() => {
        if (socket.destroyed || socket.writableEnded || sent >= 20) {
          clearInterval(timer);

          return;
        }

        sent += 1;
        socket.write(`${chunk.length.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write("\r\n");
      }, 10);

      socket.on("close", () => {
        clearInterval(timer);
      });
    });

    expect(response).toContain("HTTP/1.1 413");
    expect(response).toContain("Payload Too Large");

    // The server survived the flood and keeps serving other requests.
    const pingResponse = await fetch(`http://localhost:${port}/ping`);
    expect(pingResponse.status).toBe(200);
  } finally {
    await httpServer.close();
    consoleError.mockRestore();
  }
}, 10_000);

const buildLargeInitializeRequest = (padding: number) =>
  JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "x".repeat(padding), version: "1.0.0" },
      protocolVersion: "2024-11-05",
    },
  });

it("accepts a multi-megabyte request body under the default cap", async () => {
  // The body cap must not reject payloads that MCP clients legitimately
  // send - base64 images, documents and large pasted text routinely push a
  // single tool call past a megabyte.
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    port,
    stateless: true,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: buildLargeInitializeRequest(1_500_000), // ~1.5 MiB
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
  } finally {
    await httpServer.close();
  }
}, 20_000);

it("buffers a request body without limit when maxBodySize is false", async () => {
  // `false` restores the pre-cap behaviour for deployments that bound body
  // size at the gateway instead. The payload here is over the default cap,
  // so it only succeeds because the cap is disabled.
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      return new Server(
        { name: "test", version: "1.0.0" },
        { capabilities: {} },
      );
    },
    maxBodySize: false,
    port,
    stateless: true,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: buildLargeInitializeRequest(11_534_336), // 11 MiB, over the 10 MiB default
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
  } finally {
    await httpServer.close();
  }
}, 30_000);

it("returns 500 instead of crashing when connecting the server fails on the stateless path", async () => {
  // Regression test: the stream POST paths called `server.connect(transport)`
  // without awaiting it. `Protocol.connect()` returns a promise, so a
  // rejection escaped the `try`/`catch` that wraps the whole handler, became
  // an unhandled rejection and killed the process on Node >= 15 instead of
  // producing the 500 the catch block is there to produce.
  //
  // The failure is injected directly: `connect` rejects on every request, so
  // the 500s below depend only on the handler awaiting `connect`, never on
  // the ordering of async events. (An earlier version of this test triggered
  // the rejection with a shared, already-connected `Server` and raced the
  // first transport's `onclose`, which made it flaky in CI.)
  const port = await getRandomPort();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const server = new Server(
    { name: "test", version: "1.0.0" },
    { capabilities: {} },
  );
  vi.spyOn(server, "connect").mockRejectedValue(
    new Error("Already connected to a transport"),
  );

  const httpServer = await startHTTPServer({
    createServer: async () => server,
    port,
    stateless: true,
  });

  const postToMcp = (body: unknown) =>
    fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

  try {
    // An initialize request with no session id takes the first of the two
    // branches that had the missing await.
    const initialize = await postToMcp({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    });
    await initialize.body?.cancel();

    // A request with no session id that is not an initialize takes the other
    // branch, which had the same missing await.
    const ping = await postToMcp({ id: 2, jsonrpc: "2.0", method: "ping" });
    await ping.body?.cancel();

    // Give any rejection a tick to surface before asserting.
    await delay(100);

    expect(initialize.status).toBe(500);
    expect(ping.status).toBe(500);
    expect(unhandledRejections).toEqual([]);
  } finally {
    await httpServer.close();
    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
  }
}, 15_000);

it("closes the legacy server when connect rejects after createServer acquires a resource", async () => {
  const port = await getRandomPort();
  let liveResources = 0;

  const server = new Server(
    { name: "cleanup-repro", version: "1.0.0" },
    { capabilities: {} },
  );
  vi.spyOn(server, "connect").mockRejectedValue(
    new Error("connect failed after createServer acquired a resource"),
  );
  const close = vi.spyOn(server, "close").mockImplementation(async () => {
    liveResources -= 1;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => {
      liveResources += 1;
      return server;
    },
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
          clientInfo: { name: "cleanup-repro", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(close).toHaveBeenCalledOnce();
    expect(liveResources).toBe(0);
  } finally {
    consoleError.mockRestore();
    await httpServer.close();
  }
}, 15_000);

it("closes the modern server when initialization fails after createServer acquires a resource", async () => {
  const port = await getRandomPort();
  let liveResources = 0;

  const server = new Server(
    { name: "cleanup-control", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const close = vi.spyOn(server, "close").mockImplementation(async () => {
    liveResources -= 1;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => {
      liveResources += 1;
      return server;
    },
    onConnect: async () => {
      throw new Error("initialization failed after createServer acquired a resource");
    },
    port,
  });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "cleanup-control",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
      },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(close).toHaveBeenCalledOnce();
    expect(liveResources).toBe(0);
  } finally {
    consoleError.mockRestore();
    await httpServer.close();
  }
}, 15_000);

/**
 * The two tests above both fail before `connect` attaches a transport, which is
 * the easy half of the problem. This is the other half: the legacy stateless
 * `initialize` branch installs its own `transport.onclose`, and a `connect`
 * that succeeded hands that transport to the SDK. Closing the server therefore
 * re-enters that handler, which cleans up unconditionally in stateless mode -
 * so the failure path has to claim the cleanup flag rather than hand the
 * consumer's `onClose` the same server twice.
 */
it("closes the legacy stateless server exactly once when onConnect throws after connect succeeds", async () => {
  const port = await getRandomPort();
  let liveResources = 0;
  let onCloseCalls = 0;

  const server = new Server(
    { name: "cleanup-once", version: "1.0.0" },
    { capabilities: {} },
  );
  // Deliberately not stubbed: the real `close()` is what tears down the
  // attached transport and re-enters `transport.onclose`.
  const close = vi.spyOn(server, "close");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => {
      liveResources += 1;

      return server;
    },
    onClose: async () => {
      onCloseCalls += 1;
      liveResources -= 1;
    },
    onConnect: async () => {
      throw new Error("initialization failed after connect attached");
    },
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
          clientInfo: { name: "cleanup-once", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(500);

    // The SDK invokes `transport.onclose` without awaiting it, so a duplicate
    // cleanup lands after the response. Give it room to arrive, otherwise this
    // passes on a broken build for the wrong reason.
    await delay(250);

    expect(onCloseCalls).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(liveResources).toBe(0);
  } finally {
    close.mockRestore();
    consoleError.mockRestore();
    await httpServer.close();
  }
}, 15_000);

/**
 * Ending a session is the client's job, and 2025-era clients overwhelmingly
 * never do it - they close a laptop or lose a network and are never heard from
 * again. The tests below cover the reaper that reclaims those, and the two ways
 * it could get liveness wrong: reaping a client that is merely quiet, and
 * treating a long-attached stream as staleness the moment it drops.
 */
const initializeStreamSession = async (port: number) => {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const sessionId = response.headers.get("mcp-session-id");

  // Draining rather than cancelling leaves the session with nothing attached,
  // which is the state the reaper is meant to act on.
  await response.text();

  expect(sessionId).toBeTruthy();

  return sessionId!;
};

const pingStreamSession = (port: number, sessionId: string) =>
  fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "ping" }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-session-id": sessionId,
    },
    method: "POST",
  });

it("closes a stream session whose client went away without a DELETE", async () => {
  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    onClose,
    port,
    sessionIdleTimeout: 250,
  });

  try {
    const sessionId = await initializeStreamSession(port);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    const afterReap = await pingStreamSession(port, sessionId);

    expect(afterReap.status).toBe(404);
    expect(await afterReap.text()).toContain("Session not found");
  } finally {
    await httpServer.close();
  }
}, 15_000);

it("keeps a stream session that is attached but making no requests", async () => {
  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    onClose,
    port,
    sessionIdleTimeout: 250,
  });

  const controller = new AbortController();

  try {
    const sessionId = await initializeStreamSession(port);

    const notifications = await fetch(`http://localhost:${port}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
      method: "GET",
      signal: controller.signal,
    });

    expect(notifications.status).toBe(200);

    // Several sweeps' worth. A client parked on the notification stream issues
    // no requests at all, so idleness measured on requests alone would reap it
    // here - which is exactly what `keepAliveTimeout` exists to prevent.
    await delay(1_500);

    expect(onClose).not.toHaveBeenCalled();

    const stillServing = await pingStreamSession(port, sessionId);

    expect(stillServing.status).toBe(200);

    await stillServing.text();
  } finally {
    controller.abort();

    await httpServer.close();
  }
}, 15_000);

it("starts the idle countdown when the stream drops, not at the last request", async () => {
  const port = await getRandomPort();

  let closedAt: number | undefined;

  const onClose = vi.fn().mockImplementation(async () => {
    closedAt ??= Date.now();
  });

  const sessionIdleTimeout = 800;

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    onClose,
    port,
    sessionIdleTimeout,
  });

  const controller = new AbortController();

  try {
    const sessionId = await initializeStreamSession(port);

    const notifications = await fetch(`http://localhost:${port}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
      method: "GET",
      signal: controller.signal,
    });

    expect(notifications.status).toBe(200);

    // Long enough that a countdown running from the last request has expired
    // many times over by the time the stream drops.
    await delay(2_400);

    const droppedAt = Date.now();

    controller.abort();

    await vi.waitFor(() => expect(closedAt).toBeDefined(), { timeout: 5_000 });

    // Measured rather than probed, because a probe request would itself count
    // as activity. A countdown anchored to the last request would have expired
    // before the drop and reaped on the first sweep after it; anchoring to the
    // drop cannot close sooner than the timeout.
    expect(closedAt! - droppedAt).toBeGreaterThanOrEqual(sessionIdleTimeout);
  } finally {
    controller.abort();

    await httpServer.close();
  }
}, 15_000);

it("keeps every stream session when sessionIdleTimeout is 0", async () => {
  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    onClose,
    port,
    sessionIdleTimeout: 0,
  });

  try {
    const sessionId = await initializeStreamSession(port);

    await delay(1_000);

    expect(onClose).not.toHaveBeenCalled();

    const stillServing = await pingStreamSession(port, sessionId);

    expect(stillServing.status).toBe(200);

    await stillServing.text();
  } finally {
    await httpServer.close();
  }
}, 15_000);

it("does not reap a session while a slow request is still on the wire", async () => {
  const port = await getRandomPort();
  const onClose = vi.fn().mockResolvedValue(undefined);

  const httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    onClose,
    port,
    sessionIdleTimeout: 300,
  });

  try {
    const sessionId = await initializeStreamSession(port);

    const body = JSON.stringify({ id: 2, jsonrpc: "2.0", method: "ping" });

    const answer = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const request = http.request(
          {
            headers: {
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "mcp-session-id": sessionId,
              "Transfer-Encoding": "chunked",
            },
            host: "localhost",
            method: "POST",
            path: "/mcp",
            port,
          },
          (response) => {
            let text = "";

            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              text += chunk;
            });
            response.on("end", () => {
              resolve({ status: response.statusCode!, text });
            });
          },
        );

        request.on("error", reject);

        // Dribbled out so the upload alone outlasts the idle timeout several
        // times over. Claiming the session only after the body is read would
        // let a sweep close it here, and the client would be told its session
        // does not exist after uploading the whole request successfully.
        void (async () => {
          for (const chunk of body) {
            request.write(chunk);

            await delay(20);
          }

          request.end();
        })();
      },
    );

    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain("Session not found");
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    await httpServer.close();
  }
}, 15_000);

it("finishes reaping a session whose onClose rejects", async () => {
  const port = await getRandomPort();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  process.on("unhandledRejection", onUnhandledRejection);

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const server = new Server(
    { name: "test", version: "1.0.0" },
    { capabilities: {} },
  );
  const serverClose = vi.spyOn(server, "close");

  const onClose = vi.fn().mockRejectedValue(new Error("onClose failed"));

  const httpServer = await startHTTPServer({
    createServer: async () => server,
    onClose,
    port,
    sessionIdleTimeout: 250,
  });

  try {
    await initializeStreamSession(port);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    // Several more sweeps. The SDK invokes `onclose` without awaiting it, so a
    // rejection escaping teardown is unhandled - fatal under Node's default -
    // and abandons the rest of it, leaving the session behind with its cleanup
    // flag already set so nothing retries.
    await delay(1_000);

    await vi.waitFor(() => expect(serverClose).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toEqual([]);
  } finally {
    await httpServer.close();

    consoleError.mockRestore();
    process.off("unhandledRejection", onUnhandledRejection);
  }
}, 15_000);

it("pauses the request stream when a chunked body overflows the cap, instead of ingesting more", async () => {
  // Regression test for the getBody() streaming overflow branch. When the
  // running byte count crossed maxBodySize the promise resolved with
  // { tooLarge: true } but the stream was left in flowing mode. It kept
  // emitting "data" after the caller had already decided to answer 413,
  // buffering an unbounded oversize body and racing sendPayloadTooLarge()'s
  // teardown. Pausing the stream in that branch applies TCP backpressure and
  // stops further ingestion.
  //
  // A PassThrough stands in for the http.IncomingMessage: getBody only uses
  // the readable side and request.headers, and a raw socket cannot make the
  // "keeps flowing after resolve" race observable as deterministically.
  const maxBodySize = 256;

  const request = new PassThrough() as unknown as http.IncomingMessage;
  (request as unknown as { headers: http.IncomingHttpHeaders }).headers = {};

  const resultPromise = getBody(request, maxBodySize);

  // First writes already exceed the cap, split across chunks so only the
  // streaming counter (not a declared Content-Length) can catch it.
  (request as unknown as PassThrough).write(Buffer.alloc(200, "a"));
  (request as unknown as PassThrough).write(Buffer.alloc(200, "b"));

  const result = await resultPromise;

  expect(result).toEqual({ limit: maxBodySize, tooLarge: true });

  // The overflow branch must have paused the stream so the socket backs off.
  expect((request as unknown as PassThrough).isPaused()).toBe(true);

  // Prove no more bytes are ingested after the decision: a probe attached now
  // must stay silent. Without the pause the stream is still flowing and this
  // listener fires on the next write, which is the exact race being fixed.
  let dataAfterResolve = 0;
  (request as unknown as PassThrough).on("data", () => {
    dataAfterResolve += 1;
  });
  (request as unknown as PassThrough).write(Buffer.alloc(200, "c"));

  await delay(30);

  expect(dataAfterResolve).toBe(0);
});
