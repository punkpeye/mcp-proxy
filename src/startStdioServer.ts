import type {
  ClientOptions,
  SSEClientTransportOptions,
  StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import type { ServerCapabilities } from "@modelcontextprotocol/server";

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { proxyServer } from "./proxyServer.js";

export enum ServerType {
  HTTPStream = "HTTPStream",
  SSE = "SSE",
}

/**
 * How the upstream connection picks a protocol revision.
 *
 * - `legacy` (default) - the 2025 `initialize` handshake, no probe. Unchanged
 *   behavior, and the right default: it is one fewer round trip and every
 *   deployed server still answers it.
 * - `auto` - probe with `server/discover` first and fall back to `initialize`
 *   against a 2025-only server. Needed to reach a 2026-07-28 server.
 * - `modern` - 2026-07-28 or nothing; `connect()` rejects against a 2025-only
 *   server rather than silently downgrading.
 */
export type UpstreamProtocol = "auto" | "legacy" | "modern";

export const resolveVersionNegotiation = (
  upstreamProtocol: UpstreamProtocol = "legacy",
): ClientOptions["versionNegotiation"] => {
  if (upstreamProtocol === "auto") {
    return { mode: "auto" };
  }

  if (upstreamProtocol === "modern") {
    return { mode: { pin: "2026-07-28" } };
  }

  return undefined;
};

export const startStdioServer = async ({
  initStdioServer,
  initStreamClient,
  serverType,
  transportOptions = {},
  upstreamProtocol = "legacy",
  url,
}: {
  initStdioServer?: () => Promise<Server>;
  /**
   * Bring your own upstream client. `upstreamProtocol` does not apply to it -
   * configure `versionNegotiation` on the client you construct.
   */
  initStreamClient?: () => Promise<Client>;
  serverType: ServerType;
  transportOptions?:
    | SSEClientTransportOptions
    | StreamableHTTPClientTransportOptions;
  upstreamProtocol?: UpstreamProtocol;
  url: string;
}): Promise<Server> => {
  let transport: SSEClientTransport | StreamableHTTPClientTransport;
  switch (serverType) {
    case ServerType.SSE:
      transport = new SSEClientTransport(new URL(url), transportOptions);
      break;
    default:
      transport = new StreamableHTTPClientTransport(
        new URL(url),
        transportOptions,
      );
  }
  const streamClient = initStreamClient
    ? await initStreamClient()
    : new Client(
        {
          name: "mcp-proxy",
          version: "1.0.0",
        },
        {
          capabilities: {},
          versionNegotiation: resolveVersionNegotiation(upstreamProtocol),
        },
      );

  await streamClient.connect(transport);

  const serverVersion = streamClient.getServerVersion() as {
    name: string;
    version: string;
  };

  const serverCapabilities =
    streamClient.getServerCapabilities() as ServerCapabilities;

  const stdioServer = initStdioServer
    ? await initStdioServer()
    : new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

  await proxyServer({
    client: streamClient,
    server: stdioServer,
    serverCapabilities,
  });

  // A bare `connect(new StdioServerTransport())`, which binds the connection to
  // the 2025 era at `initialize`. Serving 2026-07-28 here needs `serveStdio`,
  // and that entry wants a factory it can call more than once - it builds a
  // separate instance for a `server/discover` probe and closes it again. Handing
  // it this one instance instead lets the probe pin its version and then close
  // it, which leaves the connection answering neither era; and because the entry
  // connects a transport only when the first message arrives, the `Server` this
  // function returns would no longer be connected when it returns.
  //
  // Both are fixable, but not by reusing one instance, so this stays on the
  // 2025-era path until the return contract is reworked to hand back the
  // entry's own handle.
  await stdioServer.connect(new StdioServerTransport());

  return stdioServer;
};
