import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { it, expect, vi } from "vitest";
import { startSSEServer } from "./startSSEServer.js";
import { getRandomPort } from "get-port-please";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { EventSource } from "eventsource";
import { setTimeout as delay } from "node:timers/promises";
import { proxyServer } from "./proxyServer.js";

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

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

  const port = await getRandomPort();

  const onConnect = vi.fn();
  const onClose = vi.fn();

  await startSSEServer({
    createServer: async () => {
      const mcpServer = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        server: mcpServer,
        client: stdioClient,
        serverCapabilities,
      });

      return mcpServer;
    },
    port,
    endpoint: "/sse",
    onConnect,
    onClose,
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
        uri: "file:///example.txt",
        name: "Example Resource",
      },
    ],
  });

  expect(await sseClient.readResource({uri: (result.resources[0].uri)},{})).toEqual({
    contents: [
      {
        uri: "file:///example.txt",
        mimeType: "text/plain",
        text: "This is the content of the example resource.",
      },
    ],
  });
  expect(await sseClient.subscribeResource({ uri: "xyz" })).toEqual({});
  expect(await sseClient.unsubscribeResource({ uri: "xyz" })).toEqual({});

  expect(onConnect).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await sseClient.close();

  await delay(100);

  expect(onClose).toHaveBeenCalled();
});
