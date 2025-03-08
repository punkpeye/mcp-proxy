#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { proxyServer, startSSEServer } from "../MCPProxy.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers/promises";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import util from "node:util";

util.inspect.defaultOptions.depth = 8;

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

const argv = await yargs(hideBin(process.argv))
  .scriptName("mcp-proxy")
  .command("$0 <command> [args...]", "Run a command with MCP arguments")
  .positional("command", {
    type: "string",
    describe: "The command to run",
    demandOption: true,
  })
  .positional("args", {
    type: "string",
    array: true,
    describe: "The arguments to pass to the command",
  })
  .options({
    debug: {
      type: "boolean",
      describe: "Enable debug logging",
      default: false,
    },
    endpoint: {
      type: "string",
      describe: "The endpoint to listen on for SSE",
      default: "/sse",
    },
    port: {
      type: "number",
      describe: "The port to listen on for SSE",
      default: 8080,
    },
  })
  .help()
  .parseAsync();

const connect = async (client: Client) => {
  const transport = new StdioClientTransport({
    command: argv.command,
    args: argv.args,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });

  console.info("connecting to the MCP server...");

  await client.connect(transport);

  console.info("connected to the MCP server");
};

const proxy = async () => {
  const client = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await connect(client);

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = client.getServerCapabilities() as {};

  console.info("starting the SSE server on port %d", argv.port);

  await startSSEServer({
    createServer: async () => {
      const server = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      proxyServer({
        server,
        client,
        serverCapabilities,
      });

      return server;
    },
    port: argv.port,
    endpoint: argv.endpoint as `/${string}`,
  });
};

const main = async () => {
  try {
    await proxy();
  } catch (error) {
    console.error("could not start the proxy", error);

    await setTimeout(1000);

    process.exit(1);
  }
};

await main();
