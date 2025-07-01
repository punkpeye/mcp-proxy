#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { setTimeout } from "node:timers";
import util from "node:util";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { InMemoryEventStore } from "../InMemoryEventStore.js";
import { proxyServer } from "../proxyServer.js";
import { SSEServer, startHTTPServer } from "../startHTTPServer.js";
import { StdioClientTransport } from "../StdioClientTransport.js";

util.inspect.defaultOptions.depth = 8;

if (!("EventSource" in global)) {
  // @ts-expect-error - figure out how to use --experimental-eventsource with vitest
  global.EventSource = EventSource;
}

const argv = await yargs(hideBin(process.argv))
  .scriptName("mcp-proxy")
  .command("$0 <command> [args...]", "Run a command with MCP arguments")
  .positional("command", {
    demandOption: true,
    describe: "The command to run",
    type: "string",
  })
  .positional("args", {
    array: true,
    describe: "The arguments to pass to the command",
    type: "string",
  })
  .env("MCP_PROXY")
  .parserConfiguration({
    "populate--": true,
  })
  .options({
    debug: {
      default: false,
      describe: "Enable debug logging",
      type: "boolean",
    },
    endpoint: {
      describe: "The endpoint to listen on",
      type: "string",
    },
    gracefulShutdownTimeout: {
      default: 5000,
      describe: "The timeout (in milliseconds) for graceful shutdown",
      type: "number",
    },
    host: {
      default: "::",
      describe: "The host to listen on",
      type: "string",
    },
    port: {
      default: 8080,
      describe: "The port to listen on",
      type: "number",
    },
    server: {
      choices: ["sse", "stream"],
      describe:
        "The server type to use (sse or stream). By default, both are enabled",
      type: "string",
    },
    shell: {
      default: false,
      describe: "Spawn the server via the user's shell",
      type: "boolean",
    },
    sseEndpoint: {
      default: "/sse",
      describe: "The SSE endpoint to listen on",
      type: "string",
    },
    streamEndpoint: {
      default: "/mcp",
      describe: "The stream endpoint to listen on",
      type: "string",
    },
  })
  .help()
  .parseAsync();

// Determine the final command and args
if (!argv.command) {
  throw new Error("No command specified");
}

const finalCommand = argv.command;
// If -- separator was used, args after -- are in argv["--"], otherwise use parsed args
const finalArgs = (argv["--"] as string[]) || argv.args;

const connect = async (client: Client) => {
  const transport = new StdioClientTransport({
    args: finalArgs,
    command: finalCommand,
    env: process.env as Record<string, string>,
    onEvent: (event) => {
      if (argv.debug) {
        console.debug("transport event", event);
      }
    },
    shell: argv.shell,
    stderr: "pipe",
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
    },
  );

  await connect(client);

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = client.getServerCapabilities() as {
    capabilities: Record<string, unknown>;
  };

  console.info("starting server on port %d", argv.port);

  const createServer = async () => {
    const server = new Server(serverVersion, {
      capabilities: serverCapabilities,
    });

    proxyServer({
      client,
      server,
      serverCapabilities,
    });

    return server;
  };

  const server = await startHTTPServer({
    createServer,
    eventStore: new InMemoryEventStore(),
    host: argv.host,
    port: argv.port,
    sseEndpoint:
      argv.server && argv.server !== "sse"
        ? null
        : (argv.sseEndpoint ?? argv.endpoint),
    streamEndpoint:
      argv.server && argv.server !== "stream"
        ? null
        : (argv.streamEndpoint ?? argv.endpoint),
  });

  return {
    close: () => {
      return server.close();
    },
  };
};

const createGracefulShutdown = ({
  server,
  timeout,
}: {
  server: SSEServer;
  timeout: number;
}) => {
  const gracefulShutdown = () => {
    console.info("received shutdown signal; shutting down");

    server.close();

    setTimeout(() => {
      // Exit with non-zero code to indicate failure to shutdown gracefully
      process.exit(1);
    }, timeout).unref();
  };

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  return () => {
    server.close();
  };
};

const main = async () => {
  try {
    const server = await proxy();

    createGracefulShutdown({
      server,
      timeout: argv.gracefulShutdownTimeout,
    });
  } catch (error) {
    console.error("could not start the proxy", error);

    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

await main();
