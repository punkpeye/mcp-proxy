import type { ServerCapabilities } from "@modelcontextprotocol/server";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport, Server, Tool } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { startHTTPServer } from "./startHTTPServer.js";

/**
 * What a proxied request carries besides its params: the caller's cancellation,
 * its progress token, and the level it asked to be logged at. The upstream here
 * is in-process, so these run without spawning a server.
 */

const TOOLS: Tool[] = [
  {
    description: "Reports progress, then finishes",
    inputSchema: { properties: {}, type: "object" },
    name: "slow",
  },
];

type Upstream = {
  aborted: () => boolean;
  client: Client;
  loggingLevel: () => string | undefined;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const createUpstream = async (): Promise<Upstream> => {
  const server = new Server(
    { name: "upstream", version: "1.0.0" },
    { capabilities: { logging: {}, tools: {} } },
  );

  let aborted = false;
  let loggingLevel: string | undefined;

  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));

  server.setRequestHandler("logging/setLevel", async (request) => {
    loggingLevel = request.params.level;

    return {};
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;

    if (progressToken !== undefined) {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progress: 1, progressToken, total: 2 },
      });
    }

    if (request.params.arguments?.hang) {
      await new Promise<void>((resolve) => {
        ctx.mcpReq.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });

      return { content: [{ text: "aborted", type: "text" as const }] };
    }

    return { content: [{ text: "done", type: "text" as const }] };
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: "mcp-proxy", version: "1.0.0" }, {});

  await client.connect(clientTransport);

  return {
    aborted: () => aborted,
    client,
    loggingLevel: () => loggingLevel,
  };
};

const startProxy = async (upstream: Upstream) => {
  const serverCapabilities =
    upstream.client.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const server = new Server(upstream.client.getServerVersion()!, {
        capabilities: serverCapabilities,
      });

      await proxyServer({
        client: upstream.client,
        server,
        serverCapabilities,
      });

      return server;
    },
    port,
  });

  cleanups.push(async () => {
    await httpServer.close();
    await upstream.client.close();
  });

  return port;
};

const connect = async (port: number, protocol: "legacy" | "modern") => {
  const client = new Client(
    { name: `${protocol}-client`, version: "1.0.0" },
    {
      versionNegotiation:
        protocol === "modern" ? { mode: { pin: "2026-07-28" } } : undefined,
    },
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );

  return client;
};

describe("per-request context crosses the proxy", () => {
  for (const protocol of ["legacy", "modern"] as const) {
    it(`relays progress notifications to a ${protocol} client`, async () => {
      const upstream = await createUpstream();
      const port = await startProxy(upstream);
      const client = await connect(port, protocol);

      const tokens: unknown[] = [];

      client.setNotificationHandler(
        "notifications/progress",
        async (notification) => {
          tokens.push(notification.params.progressToken);
        },
      );

      // A token chosen here rather than by the SDK, because the assertion that
      // matters is which token comes back: the upstream call carries the
      // proxy's own, and the caller can only match a notification up if the
      // proxy restores the one it sent.
      await client.request({
        method: "tools/call",
        params: {
          _meta: { progressToken: "downstream-token" },
          arguments: {},
          name: "slow",
        },
      });

      await vi.waitFor(() => {
        expect(tokens).toEqual(["downstream-token"]);
      });

      await client.close();
    }, 30000);

    it(`propagates a ${protocol} client's cancellation upstream`, async () => {
      const upstream = await createUpstream();
      const port = await startProxy(upstream);
      const client = await connect(port, protocol);

      const abort = new AbortController();

      const call = client.callTool(
        { arguments: { hang: true }, name: "slow" },
        { signal: abort.signal },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      abort.abort();

      await expect(call).rejects.toThrow();

      // Without `signal` forwarded, the upstream call runs to completion and
      // the work the client gave up on keeps going.
      await vi.waitFor(() => {
        expect(upstream.aborted()).toBe(true);
      });

      await client.close();
    }, 30000);
  }

  it("keeps logging/setLevel local to the connection", async () => {
    const upstream = await createUpstream();
    const port = await startProxy(upstream);
    const client = await connect(port, "legacy");

    await client.setLoggingLevel("debug");

    // Deliberately NOT forwarded. One upstream connection is shared by every
    // downstream session and carries a single level, so forwarding lets one
    // client raise or silence another's logs; and the method does not exist on
    // a 2026-07-28 upstream at all, where forwarding is a hard error. The v2
    // `Server`'s built-in handler answers locally instead.
    expect(upstream.loggingLevel()).toBeUndefined();

    await client.close();
  }, 30000);
});
