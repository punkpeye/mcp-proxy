#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { EventSource } from "eventsource";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers";
import util from "node:util";
import { pipenet } from "pipenet";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version: string };

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
  .version(packageJson.version)
  .command("$0 [command] [args...]", "Proxy an MCP stdio server over HTTP")
  .positional("command", {
    describe: "The command to run",
    type: "string",
  })
  .positional("args", {
    array: true,
    describe: "The arguments to pass to the command",
    type: "string",
  })
  .usage("$0 [options] -- <command> [args...]\n       $0 <command> [args...]")
  .env("MCP_PROXY")
  .parserConfiguration({
    "populate--": true,
  })
  .options({
    apiKey: {
      describe: "API key for authenticating requests (uses X-API-Key header)",
      type: "string",
    },
    connectionTimeout: {
      default: 60000,
      describe:
        "The timeout (in milliseconds) for initial connection to the MCP server (default: 60 seconds)",
      type: "number",
    },
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
    requestTimeout: {
      default: 300000,
      describe:
        "The timeout (in milliseconds) for requests to the MCP server (default: 5 minutes)",
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
    sslCa: {
      describe: "Filename to override the trusted CA certificates",
      type: "string",
    },
    sslCert: {
      describe: "Cert chains filename in PEM format",
      type: "string",
    },
    sslKey: {
      describe: "Private keys filename in PEM format",
      type: "string",
    },
    stateless: {
      default: false,
      describe:
        "Enable stateless mode for HTTP streamable transport (no session management)",
      type: "boolean",
    },
    streamEndpoint: {
      default: "/mcp",
      describe: "The stream endpoint to listen on",
      type: "string",
    },
    tunnel: {
      default: false,
      describe: "Expose the proxy via a public tunnel using tunnel.gla.ma",
      type: "boolean",
    },
    tunnelSubdomain: {
      describe: "Request a specific subdomain for the tunnel (availability not guaranteed)",
      type: "string",
    },
  })
  .help()
  .parseAsync();

// If -- separator was used, everything after -- is the command and its args
const dashDashArgs = argv["--"] as string[] | undefined;

let finalCommand: string;
let finalArgs: string[];

if (dashDashArgs && dashDashArgs.length > 0) {
  // -- was used: first item after -- is command, rest are args
  [finalCommand, ...finalArgs] = dashDashArgs;
} else if (argv.command) {
  // No -- used: use positional command and args
  finalCommand = argv.command as string;
  finalArgs = (argv.args as string[]) || [];
} else {
  console.error("Error: No command specified.");
  console.error("Usage: mcp-proxy [options] -- <command> [args...]");
  console.error("   or: mcp-proxy <command> [args...]");
  console.error("");
  console.error("Examples:");
  console.error("  mcp-proxy --port 8080 -- node server.js --port 3000");
  console.error("  mcp-proxy node server.js");
  process.exit(1);
}

const connect = async (client: Client, connectionTimeout: number) => {
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
    // We want to passthrough stderr from the MCP server to enable better debugging
    stderr: "inherit",
  });

  await client.connect(transport, { timeout: connectionTimeout });
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

  await connect(client, argv.connectionTimeout);

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
      requestTimeout: argv.requestTimeout,
      server,
      serverCapabilities,
    });

    return server;
  };

  const server = await startHTTPServer({
    apiKey: argv.apiKey,
    createServer,
    eventStore: new InMemoryEventStore(),
    host: argv.host,
    port: argv.port,
    sseEndpoint:
      argv.server && argv.server !== "sse"
        ? null
        : (argv.sseEndpoint ?? argv.endpoint),
    sslCa: argv.sslCa,
    sslCert: argv.sslCert,
    sslKey: argv.sslKey,
    stateless: argv.stateless,
    streamEndpoint:
      argv.server && argv.server !== "stream"
        ? null
        : (argv.streamEndpoint ?? argv.endpoint),
  });

  let tunnel: Awaited<ReturnType<typeof pipenet>> | undefined;

  if (argv.tunnel) {
    console.info("establishing tunnel via tunnel.gla.ma");
    tunnel = await pipenet({
      host: "https://tunnel.gla.ma",
      port: argv.port,
      subdomain: argv.tunnelSubdomain,
    });
    console.info("tunnel established at %s", tunnel.url);
  }

  return {
    close: async () => {
      await server.close();
      if (tunnel) {
        await tunnel.close();
      }
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

  process.once("SIGTERM", gracefulShutdown);
  process.once("SIGINT", gracefulShutdown);

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

    // We give an extra second for logs to flush
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

await main();
