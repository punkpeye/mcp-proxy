#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { proxyServer, startSSEServer } from "../MCPProxy.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers/promises";
import { prefixLines } from "../utilities/prefixLines.js";

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

const transport = new StdioClientTransport({
  command: argv.command,
  args: argv.args,
  env: process.env as Record<string, string>,
  stderr: 'pipe',
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


let stderrOutput = '';

try {
  console.info('connecting to the MCP server...');

  const connectionPromise = client.connect(transport);

  transport?.stderr?.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  await connectionPromise;

  console.info('connected to the MCP server');
} catch (error) {
  console.error('could not connect to the MCP server', error, prefixLines(stderrOutput, '> '));

  await setTimeout(1000);

  process.exit(1);
}

const serverVersion = client.getServerVersion() as {
  name: string;
  version: string;
};

const serverCapabilities = client.getServerCapabilities() as {};

try {
  console.info('starting the SSE server on port %d', argv.port);

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
} catch (error) {
  console.error('could not start the SSE server', error);

  await setTimeout(1000);

  process.exit(1);
}
