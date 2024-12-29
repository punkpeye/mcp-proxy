import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { it, expect } from "vitest";
import { proxyServer, startSseServer } from "./MCPProxy.js";
import { getRandomPort } from "get-port-please";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { EventSource } from "eventsource";

// @ts-expect-error - figure out how to use --experimental-eventsource with vitest
global.EventSource = EventSource;

it("proxies messages between SSE and stdio servers", async () => {
  const stdioTransport = new StdioClientTransport({
    command: "tsx",
    args: ["src/simple-stdio-server.ts"],
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

  const serverCapabilities = stdioClient.getServerCapabilities() as {};

  const sseServer = new Server(serverVersion, {
    capabilities: serverCapabilities,
  });

  proxyServer({
    server: sseServer,
    client: stdioClient,
    serverCapabilities,
  });

  const port = await getRandomPort();

  await startSseServer({
    server: sseServer,
    port,
    endpoint: "/sse",
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

  expect(await sseClient.listResources()).toEqual({
    resources: [
      {
        uri: "file:///example.txt",
        name: "Example Resource",
      },
    ],
  });
});
