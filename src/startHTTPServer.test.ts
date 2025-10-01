import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { getRandomPort } from "get-port-please";
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

it("does not call authenticate on subsequent requests in stateful mode", async () => {
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

  // Make first request
  await streamClient.listResources();

  // Make second request
  await streamClient.listResources();

  // In stateful mode, authenticate should NOT be called per-request
  // It may be called during initialization, but not on every tool call
  // The key is that it's not called multiple times for each request
  expect(authenticate).not.toHaveBeenCalled();

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
