import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { EventSource } from "eventsource";
import { getRandomPort } from "get-port-please";
import { ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerType } from "./startStdioServer.js";

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

/**
 * Each case boots two `tsx` children - the upstream HTTP fixture and the stdio
 * proxy under test - so the wall clock is dominated by TypeScript
 * transpilation, not the protocol exchange. Both the hook and the tests need
 * more than vitest's defaults, which is what the explicit timeouts are for.
 */
describe("startStdioServer.test.ts", () => {
  let port: number;
  let proc: ChildProcess;

  // Spawning `tsx` pays TypeScript transpilation before the fixture listens,
  // and vitest runs test files in parallel, so the default 10s hook timeout is
  // not enough headroom under load.
  beforeEach(async () => {
    port = await getRandomPort();
    proc = spawn("tsx", ["src/fixtures/backwards-compatible-http-server.ts"], {
      env: { ...process.env, PORT: String(port) },
      stdio: "pipe",
    });
    await new Promise((resolve) => {
      proc.stdout?.on("data", (data) => {
        if (
          data
            .toString()
            .includes("Backwards compatible MCP server listening on port")
        ) {
          resolve(null);
        }
      });
    });
  }, 30000);

  afterEach(async () => {
    proc.kill();
  });

  it("proxies messages between stdio and sse servers", async () => {
    const stdioTransport = new StdioClientTransport({
      args: [
        "src/fixtures/simple-stdio-proxy-server.ts",
        JSON.stringify({
          serverType: ServerType.SSE,
          url: `http://127.0.0.1:${port}/sse`,
        }),
      ],
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

    let notificationCount = 0;

    stdioClient.setNotificationHandler(
      "notifications/message",
      (notification) => {
        console.log(
          `Notification: ${notification.params.level} - ${notification.params.data}`,
        );
        notificationCount++;
      },
    );

    await stdioClient.connect(stdioTransport);

    const result = await stdioClient.listTools();

    expect(result).toEqual({
      tools: [
        {
          description:
            "Starts sending periodic notifications for testing resumability",
          inputSchema: {
            properties: {
              count: {
                default: 50,
                description: "Number of notifications to send (0 for 100)",
                type: "number",
              },
              interval: {
                default: 100,
                description: "Interval in milliseconds between notifications",
                type: "number",
              },
            },
            type: "object",
          },
          name: "start-notification-stream",
        },
      ],
    });

    const notificationResult = await stdioClient.callTool({
      arguments: {
        count: 2,
        interval: 100,
      },
      name: "start-notification-stream",
    });

    expect(notificationResult).toEqual({
      content: [
        {
          text: "Started sending periodic notifications every 100ms",
          type: "text",
        },
      ],
    });

    expect(notificationCount).toEqual(2);

    await stdioClient.close();
  }, 30000);

  it("proxies messages between stdio and stream able servers", async () => {
    const stdioTransport = new StdioClientTransport({
      args: [
        "src/fixtures/simple-stdio-proxy-server.ts",
        JSON.stringify({
          serverType: ServerType.HTTPStream,
          url: `http://127.0.0.1:${port}/mcp`,
        }),
      ],
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

    let notificationCount = 0;

    stdioClient.setNotificationHandler(
      "notifications/message",
      (notification) => {
        console.log(
          `Notification: ${notification.params.level} - ${notification.params.data}`,
        );
        notificationCount++;
      },
    );

    await stdioClient.connect(stdioTransport);

    const result = await stdioClient.listTools();

    expect(result).toEqual({
      tools: [
        {
          description:
            "Starts sending periodic notifications for testing resumability",
          inputSchema: {
            properties: {
              count: {
                default: 50,
                description: "Number of notifications to send (0 for 100)",
                type: "number",
              },
              interval: {
                default: 100,
                description: "Interval in milliseconds between notifications",
                type: "number",
              },
            },
            type: "object",
          },
          name: "start-notification-stream",
        },
      ],
    });
    const notificationResult = await stdioClient.callTool({
      arguments: {
        count: 2,
        interval: 100,
      },
      name: "start-notification-stream",
    });

    expect(notificationResult).toEqual({
      content: [
        {
          text: "Started sending periodic notifications every 100ms",
          type: "text",
        },
      ],
    });

    expect(notificationCount).toEqual(2);

    await stdioClient.close();
  }, 30000);
});
