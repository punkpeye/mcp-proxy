import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { EventSource } from "eventsource";
import { getRandomPort } from "get-port-please";
import { describe, expect, it } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { startHTTPServer } from "./startHTTPServer.js";

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

interface TestConfig {
  requestTimeout?: number;
  serverDelay?: string;
  serverFixture?: string;
}

interface TestEnvironment {
  cleanup: () => Promise<void>;
  httpServer: { close: () => Promise<void> };
  stdioClient: Client;
  streamClient: Client;
}

async function createTestEnvironment(
  config: TestConfig = {},
): Promise<TestEnvironment> {
  const {
    requestTimeout,
    serverDelay,
    serverFixture = "simple-stdio-server.ts",
  } = config;

  const stdioTransport = new StdioClientTransport({
    args: [`src/fixtures/${serverFixture}`],
    command: "tsx",
    env: serverDelay
      ? ({ ...process.env, RESPONSE_DELAY: serverDelay } as Record<
          string,
          string
        >)
      : (process.env as Record<string, string>),
  });

  const stdioClient = new Client(
    { name: "mcp-proxy-test", version: "1.0.0" },
    { capabilities: {} },
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
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });
      await proxyServer({
        client: stdioClient,
        requestTimeout,
        server: mcpServer,
        serverCapabilities,
      });
      return mcpServer;
    },
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

  return {
    cleanup: async () => {
      await streamClient.close();
      await stdioClient.close();
    },
    httpServer,
    stdioClient,
    streamClient,
  };
}

describe("proxyServer timeout functionality", () => {
  it("should respect custom timeout settings", async () => {
    const { cleanup, streamClient } = await createTestEnvironment({
      requestTimeout: 1000,
      serverDelay: "500",
      serverFixture: "slow-stdio-server.ts",
    });

    // This should succeed as timeout (1s) > delay (500ms)
    const result = await streamClient.listResources();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("Slow Resource");

    await cleanup();
  }, 10000);

  it("should timeout when request takes longer than configured timeout", async () => {
    const { cleanup, streamClient } = await createTestEnvironment({
      requestTimeout: 500,
      serverDelay: "1000",
      serverFixture: "slow-stdio-server.ts",
    });

    // This should throw a timeout error as delay (1s) > timeout (500ms)
    await expect(streamClient.listResources()).rejects.toThrow(McpError);

    await cleanup();
  }, 10000);

  it("should use default SDK timeout when no custom timeout is provided", async () => {
    const { cleanup, streamClient } = await createTestEnvironment();

    // This should succeed with default timeout
    const result = await streamClient.listResources();
    expect(result.resources).toBeDefined();

    await cleanup();
  }, 10000);

  it("should handle resource reads with custom timeout", async () => {
    const { cleanup, streamClient } = await createTestEnvironment({
      requestTimeout: 600,
      serverDelay: "300",
      serverFixture: "slow-stdio-server.ts",
    });

    // First get the resources
    const resources = await streamClient.listResources();
    expect(resources.resources).toHaveLength(1);

    // Resource read should succeed as timeout (600ms) > delay (300ms)
    const resourceContent = await streamClient.readResource({
      uri: resources.resources[0].uri,
    });

    expect(resourceContent.contents).toBeDefined();
    expect((resourceContent.contents[0] as { text: string }).text).toContain(
      "300ms delay",
    );

    await cleanup();
  }, 10000);
});
