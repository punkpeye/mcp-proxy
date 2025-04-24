#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers";
import { StdioClientTransport } from "../StdioClientTransport.js";
import util from "node:util";
import { startSSEServer } from "../startSSEServer.js";
import { startHTTPStreamServer } from "../startHTTPStreamServer.js";
import { proxyServer } from "../proxyServer.js";
import { InMemoryEventStore } from "../inMemoryEventStore.js";

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
  .env("MCP_PROXY")
  .options({
    debug: {
      type: "boolean",
      describe: "Enable debug logging",
      default: false,
    },
    endpoint: {
      type: "string",
      describe: "The endpoint to listen on",
    },
    port: {
      type: "number",
      describe: "The port to listen on",
      default: 8080,
    },
    server: {
      type: "string",
      describe: "The server type to use (sse or stream)",
      choices: ["sse", "stream"],
      default: "sse",
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
    onEvent: (event) => {
      if (argv.debug) {
        console.debug("transport event", event);
      }
    },
  });

  await client.connect(transport);
};

const proxy = async () => {
  const client = new Client(
    {
      name: "mcp-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await connect(client);

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = client.getServerCapabilities() as {};

  console.info("starting the %s server on port %d", argv.server, argv.port);

  const createServer = async () => {
    const server = new Server(serverVersion, {
      capabilities: serverCapabilities,
    });

    proxyServer({
      server,
      client,
      serverCapabilities,
    });

    return server;
  };

  if (argv.server === "sse") {
    await startSSEServer({
      createServer,
      port: argv.port,
      endpoint: argv.endpoint || ("/sse" as `/${string}`),
    });
  } else {
    await startHTTPStreamServer({
      createServer,
      port: argv.port,
      endpoint: argv.endpoint || ("/stream" as `/${string}`),
      eventStore: new InMemoryEventStore(),
    });
  }
};

const main = async () => {
  process.on("SIGINT", () => {
    console.info("SIGINT received, shutting down");

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  try {
    await proxy();
  } catch (error) {
    console.error("could not start the proxy", error);

    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

await main();
