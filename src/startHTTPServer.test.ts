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
