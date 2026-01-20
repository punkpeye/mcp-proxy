import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import fs from "fs";
import { getRandomPort } from "get-port-please";
import https from "https";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { startHTTPServer } from "./startHTTPServer.js";

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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

  const serverCapabilities = stdioClient.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

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
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id",
  );
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");

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
