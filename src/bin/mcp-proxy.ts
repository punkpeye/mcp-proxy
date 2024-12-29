#!/usr/bin/env node

import { EventSource } from "eventsource";

// @ts-expect-error
global.EventSource = EventSource;

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { proxyServer, startSSEServer } from "../MCPProxy.js";


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

const transport = new StdioClientTransport({
  command: argv.command,
  args: argv.args,
  env: process.env as Record<string, string>,
});

const client = new Client(
  {
    name: "mcp-proxy",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

await client.connect(transport);

const serverVersion = client.getServerVersion() as {
  name: string;
  version: string;
};

const serverCapabilities = client.getServerCapabilities() as {};

const server = new Server(serverVersion, {
  capabilities: serverCapabilities,
});

proxyServer({
  server,
  client,
  serverCapabilities,
});

await startSSEServer({
  server,
  port: argv.port,
  endpoint: argv.endpoint as `/${string}`,
});
