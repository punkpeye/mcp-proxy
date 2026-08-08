#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/client";
import { Server, ServerCapabilities } from "@modelcontextprotocol/server";
import { EventSource } from "eventsource";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers";
import util from "node:util";
import { pipenet } from "pipenet";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version: string };

import { proxyServer } from "../proxyServer.js";
import {
  DEFAULT_ALLOWED_HEADERS,
  SSEServer,
  startHTTPServer,
} from "../startHTTPServer.js";
import {
  resolveVersionNegotiation,
  UpstreamProtocol,
} from "../startStdioServer.js";
import { StdioClientTransport } from "../StdioClientTransport.js";
import {
  acquireListenSubscriptions,
  getUpstreamBridge,
} from "../upstreamNotifications.js";

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
    corsAddAllowedHeader: {
      array: true,
      describe:
        "Add a header name to Access-Control-Allow-Headers (defaults preserved). Repeat to add multiple, e.g. `--corsAddAllowedHeader X-API-Key`.",
      type: "string",
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
    eventStore: {
      default: true,
      describe:
        "Enable the streamable HTTP transport's resumability event store, which lets clients replay missed messages after a reconnect. Use --no-eventStore to disable it entirely for request/response-only deployments that don't need this and would rather avoid the memory overhead",
      type: "boolean",
    },
    eventStoreMaxEvents: {
      default: 1000,
      describe:
        "Maximum number of buffered events the resumability event store retains (per session) before it evicts the oldest; bounds memory use. Ignored when --no-eventStore is set",
      type: "number",
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
    keepAliveTimeout: {
      default: 300000,
      describe:
        "The HTTP keep-alive timeout in milliseconds for stateful stream sessions (default: 5 minutes)",
      type: "number",
    },
    maxBodySize: {
      default: 10485760,
      describe:
        "Maximum request body size in bytes accepted by the stream endpoint; larger requests are answered with 413 Payload Too Large. Bounds the memory a single request can consume (default: 10 MiB). Set to 0 to disable the limit",
      type: "number",
    },
    modern: {
      default: true,
      describe:
        "Serve MCP protocol revision 2026-07-28 on the stream endpoint alongside the 2025-era revisions. Each request is classified by its own content, so one endpoint serves both and neither client needs to know the other exists. Use --no-modern to serve only 2025-era clients. Has no effect with --server sse, which disables the stream endpoint the leg lives on",
      type: "boolean",
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
    upstreamProtocol: {
      choices: ["legacy", "auto", "modern"],
      default: "legacy",
      describe:
        "Which MCP protocol revision to speak to the spawned server. 'legacy' (default) uses the 2025 initialize handshake. 'auto' sends server/discover first and falls back to the handshake — needed to front a 2026-07-28 server, at the cost of one extra round trip, and of sending that probe to a server that may not expect it. 'modern' requires 2026-07-28 and fails against an older server",
      type: "string",
    },
  })
  .help()
  .parseAsync();

if (!(argv.eventStoreMaxEvents >= 1)) {
  console.error(
    `Error: --eventStoreMaxEvents must be a number >= 1 (got ${String(argv.eventStoreMaxEvents)}). Use --no-eventStore to disable the event store instead.`,
  );
  process.exit(1);
}

if (!(argv.maxBodySize >= 0)) {
  console.error(
    `Error: --maxBodySize must be a number >= 0 (got ${String(argv.maxBodySize)}). Use --maxBodySize 0 to disable the limit instead.`,
  );
  process.exit(1);
}

const corsOption =
  argv.corsAddAllowedHeader && argv.corsAddAllowedHeader.length > 0
    ? { allowedHeaders: [...DEFAULT_ALLOWED_HEADERS, ...argv.corsAddAllowedHeader] }
    : undefined;

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
      versionNegotiation: resolveVersionNegotiation(
        argv.upstreamProtocol as UpstreamProtocol,
      ),
    },
  );

  await connect(client, argv.connectionTimeout);

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities = client.getServerCapabilities() as ServerCapabilities;

  console.info("starting server on port %d", argv.port);

  const createServer = async () => {
    const server = new Server(serverVersion, {
      capabilities: serverCapabilities,
    });

    await proxyServer({
      client,
      requestTimeout: argv.requestTimeout,
      server,
      serverCapabilities,
    });

    return server;
  };

  const server = await startHTTPServer({
    apiKey: argv.apiKey,
    cors: corsOption,
    createServer,
    eventStore: argv.eventStore ? undefined : false,
    eventStoreMaxEvents: argv.eventStoreMaxEvents,
    host: argv.host,
    keepAliveTimeout: argv.keepAliveTimeout,
    maxBodySize: argv.maxBodySize === 0 ? false : argv.maxBodySize,
    modern: argv.modern,
    // A 2026-07-28 client asks for resource updates through its listen filter,
    // not `resources/subscribe`, so this is the only place those URIs surface.
    onListenSubscriptions: (uris) =>
      acquireListenSubscriptions({
        client,
        requestTimeout: argv.requestTimeout,
        uris,
      }),
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

  // A 2026-07-28 client receives change notifications only on a
  // `subscriptions/listen` stream, which no per-request server instance owns -
  // they are published to the handler's bus instead. The 2025-era legs get the
  // same events through their own long-lived `Server`, wired by `proxyServer`.
  getUpstreamBridge({ client, requestTimeout: argv.requestTimeout }).subscribe({
    promptsListChanged: () => server.notify.promptsChanged(),
    resourcesListChanged: () => server.notify.resourcesChanged(),
    resourceUpdated: ({ uri }) => server.notify.resourceUpdated(uri),
    toolsListChanged: () => server.notify.toolsChanged(),
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

      // Tear the upstream subscription stream down before the client, so a
      // 2026-07-28 upstream sees a clean cancel rather than a dropped socket.
      await getUpstreamBridge({ client }).close();

      // Closing the upstream client is what terminates the spawned server
      // process and releases its stdio pipes. Without it the event loop stays
      // alive after the HTTP server is down and every shutdown runs out the
      // graceful-shutdown timer and exits non-zero.
      await client.close();

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
  server: Pick<SSEServer, "close">;
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
