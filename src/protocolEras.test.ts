import type { ServerCapabilities } from "@modelcontextprotocol/server";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { startHTTPServer } from "./startHTTPServer.js";
import {
  resolveVersionNegotiation,
  UpstreamProtocol,
} from "./startStdioServer.js";
import { StdioClientTransport } from "./StdioClientTransport.js";
import {
  acquireListenSubscriptions,
  getUpstreamBridge,
} from "./upstreamNotifications.js";

/**
 * Every case here spawns a `tsx` child as the upstream server, and vitest runs
 * test files in parallel - so the wall clock is dominated by child boot under
 * load, not by the protocol exchange. The timeouts are sized for that.
 *
 * The proxy has two independent eras - the one it speaks upstream to the
 * spawned server, and the one each downstream client speaks to it. These tests
 * walk that matrix; "seamless" means every cell works without the client or
 * the server knowing the other's era.
 */

type Proxy = {
  close: () => Promise<void>;
  port: number;
  upstreamEra: string | undefined;
};

const running: Proxy[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

const startProxy = async ({
  env,
  fixture,
  modern = true,
  upstreamProtocol = "legacy",
}: {
  env?: Record<string, string>;
  fixture: string;
  modern?: boolean;
  upstreamProtocol?: UpstreamProtocol;
}): Promise<Proxy> => {
  const client = new Client(
    { name: "mcp-proxy", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: resolveVersionNegotiation(upstreamProtocol),
    },
  );

  await client.connect(
    new StdioClientTransport({
      args: [`src/fixtures/${fixture}`],
      command: "tsx",
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };
  const serverCapabilities =
    client.getServerCapabilities() as ServerCapabilities;

  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const server = new Server(serverVersion, {
        capabilities: serverCapabilities,
      });

      await proxyServer({ client, server, serverCapabilities });

      return server;
    },
    modern,
    // The same wiring `bin/mcp-proxy.ts` performs for a 2026-07-28 client's
    // listen filter, which is where its resource subscriptions arrive - the
    // shipped function rather than a copy of it, so this covers what runs.
    onListenSubscriptions: (uris) =>
      acquireListenSubscriptions({ client, uris }),
    port,
  });

  // The same wiring `bin/mcp-proxy.ts` performs: a 2026-07-28 client is fed by
  // the handler's subscription bus, which no per-request server instance owns.
  getUpstreamBridge({ client }).subscribe({
    promptsListChanged: () => httpServer.notify.promptsChanged(),
    resourcesListChanged: () => httpServer.notify.resourcesChanged(),
    resourceUpdated: ({ uri }) => httpServer.notify.resourceUpdated(uri),
    toolsListChanged: () => httpServer.notify.toolsChanged(),
  });

  const proxy: Proxy = {
    close: async () => {
      await httpServer.close();
      await client.close();
    },
    port,
    upstreamEra: client.getProtocolEra(),
  };

  running.push(proxy);

  return proxy;
};

/** The minimum per-request `_meta` envelope a 2026-07-28 request must carry. */
const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw-client", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

/** A minimal server that can answer the raw `tools/list` used by the auth tests. */
const createBareServer = async () => {
  const server = new Server(
    { name: "bare", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler("tools/list", async () => ({ tools: [] }));

  return server;
};

const connect = async (port: number, protocol: "legacy" | "modern") => {
  const client = new Client(
    { name: `${protocol}-client`, version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation:
        protocol === "modern" ? { mode: { pin: "2026-07-28" } } : undefined,
    },
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );

  return client;
};

describe("client era x upstream era", () => {
  for (const clientProtocol of ["legacy", "modern"] as const) {
    it(`serves a ${clientProtocol} client fronting a 2025-era stdio server`, async () => {
      const { port } = await startProxy({ fixture: "simple-stdio-server.ts" });

      const client = await connect(port, clientProtocol);

      expect(client.getProtocolEra()).toBe(clientProtocol);

      const resources = await client.listResources();

      expect(resources.resources).toEqual([
        { name: "Example Resource", uri: "file:///example.txt" },
      ]);

      const read = await client.readResource({ uri: "file:///example.txt" });

      expect((read.contents[0] as { text: string }).text).toContain(
        "This is the content of the example resource",
      );

      await client.close();
    }, 30000);

    it(`serves a ${clientProtocol} client fronting a 2026-07-28 stdio server`, async () => {
      const proxy = await startProxy({
        // `reject` makes the fixture refuse a 2025-era opening, so the upstream
        // era below is proof of negotiation rather than a silent fallback.
        env: { MCP_FIXTURE_LEGACY: "reject" },
        fixture: "dual-era-stdio-server.ts",
        upstreamProtocol: "modern",
      });

      expect(proxy.upstreamEra).toBe("modern");

      const client = await connect(proxy.port, clientProtocol);

      expect(client.getProtocolEra()).toBe(clientProtocol);

      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toContain("whoami");

      const result = await client.callTool({ name: "whoami" });

      expect((result.content as { text: string }[])[0].text).toBe(
        "served from the modern era",
      );

      await client.close();
    }, 30000);
  }

  it("serves both eras concurrently on one endpoint", async () => {
    const { port } = await startProxy({ fixture: "simple-stdio-server.ts" });

    const [legacy, modern] = await Promise.all([
      connect(port, "legacy"),
      connect(port, "modern"),
    ]);

    const [legacyResources, modernResources] = await Promise.all([
      legacy.listResources(),
      modern.listResources(),
    ]);

    expect(legacy.getProtocolEra()).toBe("legacy");
    expect(modern.getProtocolEra()).toBe("modern");
    expect(modernResources.resources).toEqual(legacyResources.resources);

    await Promise.all([legacy.close(), modern.close()]);
  }, 30000);

  it("falls back to the 2025 handshake when auto-probing a 2025-era server", async () => {
    const proxy = await startProxy({
      fixture: "simple-stdio-server.ts",
      upstreamProtocol: "auto",
    });

    expect(proxy.upstreamEra).toBe("legacy");

    const client = await connect(proxy.port, "modern");
    const resources = await client.listResources();

    expect(resources.resources).toHaveLength(1);

    await client.close();
  }, 30000);
});

describe("server/discover", () => {
  it("advertises the upstream server's identity and capabilities", async () => {
    const { port } = await startProxy({ fixture: "simple-stdio-server.ts" });

    const client = await connect(port, "modern");

    const discover = client.getDiscoverResult();

    expect(discover?.supportedVersions).toContain("2026-07-28");
    expect(discover?.capabilities).toEqual({
      resources: { subscribe: true },
    });
    expect(
      discover?._meta?.["io.modelcontextprotocol/serverInfo"],
    ).toMatchObject({
      name: "example-server",
      version: "1.0.0",
    });

    await client.close();
  }, 30000);
});

describe("modern leg disabled", () => {
  it("refuses 2026-07-28 traffic but still serves 2025-era clients", async () => {
    const { port } = await startProxy({
      fixture: "simple-stdio-server.ts",
      modern: false,
    });

    await expect(connect(port, "modern")).rejects.toThrow();

    const legacy = await connect(port, "legacy");

    expect((await legacy.listResources()).resources).toHaveLength(1);

    await legacy.close();
  }, 30000);
});

describe("change notifications", () => {
  const waitForToolsChanged = (client: Client) =>
    new Promise<void>((resolve) => {
      client.setNotificationHandler(
        "notifications/tools/list_changed",
        async () => {
          resolve();
        },
      );
    });

  for (const upstreamProtocol of ["legacy", "modern"] as const) {
    it(`reaches a 2025-era client from a ${upstreamProtocol} upstream`, async () => {
      const { port } = await startProxy({
        env:
          upstreamProtocol === "modern"
            ? { MCP_FIXTURE_LEGACY: "reject" }
            : undefined,
        fixture: "dual-era-stdio-server.ts",
        upstreamProtocol,
      });

      const client = await connect(port, "legacy");
      const changed = waitForToolsChanged(client);

      await client.callTool({ name: "trigger-list-changed" });
      await changed;

      await client.close();
    }, 30000);

    it(`reaches a 2026-07-28 client over subscriptions/listen from a ${upstreamProtocol} upstream`, async () => {
      const { port } = await startProxy({
        env:
          upstreamProtocol === "modern"
            ? { MCP_FIXTURE_LEGACY: "reject" }
            : undefined,
        fixture: "dual-era-stdio-server.ts",
        upstreamProtocol,
      });

      const client = await connect(port, "modern");
      const changed = waitForToolsChanged(client);

      // 2026-07-28 sends no un-requested notification; the client opts in.
      const subscription = await client.listen({ toolsListChanged: true });

      expect(subscription.honoredFilter.toolsListChanged).toBe(true);

      await client.callTool({ name: "trigger-list-changed" });
      await changed;

      await subscription.close();
      await client.close();
    }, 30000);
  }
});

describe("authentication covers both legs", () => {
  const modernRequest = (port: number, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        // Required on 2026-07-28 streamable HTTP POSTs (SEP-2243).
        "Mcp-Method": "tools/list",
        ...headers,
      },
      method: "POST",
    });

  it("rejects a 2026-07-28 request that is missing the API key", async () => {
    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      apiKey: "secret",
      createServer: createBareServer,
      port,
    });

    try {
      expect((await modernRequest(port, {})).status).toBe(401);
      expect(
        (await modernRequest(port, { "X-API-Key": "wrong" })).status,
      ).toBe(401);
      expect((await modernRequest(port, { "X-API-Key": "secret" })).status).toBe(
        200,
      );
    } finally {
      await httpServer.close();
    }
  }, 30000);

  it("runs the authenticate callback for 2026-07-28 requests", async () => {
    const seen: string[] = [];
    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      authenticate: async (request) => {
        seen.push(String(request.headers.authorization));

        if (request.headers.authorization !== "Bearer good") {
          return null;
        }

        return { userId: "u" };
      },
      createServer: createBareServer,
      port,
    });

    try {
      expect(
        (await modernRequest(port, { Authorization: "Bearer bad" })).status,
      ).toBe(401);
      expect(
        (await modernRequest(port, { Authorization: "Bearer good" })).status,
      ).toBe(200);
      expect(seen).toEqual(["Bearer bad", "Bearer good"]);
    } finally {
      await httpServer.close();
    }
  }, 30000);
});

describe("modern leg instance lifetime", () => {
  it("tears down every per-request instance, including listen streams", async () => {
    let created = 0;
    let closed = 0;

    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      createServer: async () => {
        created++;

        const server = new Server(
          { name: "counted", version: "1.0.0" },
          { capabilities: { tools: { listChanged: true } } },
        );

        server.setRequestHandler("tools/list", async () => ({ tools: [] }));

        return server;
      },
      onClose: async () => {
        closed++;
      },
      port,
    });

    try {
      const client = await connect(port, "modern");

      // `subscriptions/listen` builds an instance the SDK discards without ever
      // attaching a transport, so its `onclose` never fires on its own - the
      // path that leaked an instance (and its upstream sink) per opened stream.
      for (let round = 0; round < 4; round++) {
        const subscription = await client.listen({ toolsListChanged: true });

        await subscription.close();
      }

      await client.listTools();
      await client.close();

      expect(created).toBeGreaterThan(0);
      expect(closed).toBe(created);
    } finally {
      await httpServer.close();
    }
  }, 30000);
});

describe("shutdown", () => {
  it("does not stall after a 2026-07-28 client closed a listen stream", async () => {
    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      createServer: createBareServer,
      port,
    });

    const client = await connect(port, "modern");
    const subscription = await client.listen({ toolsListChanged: true });

    await subscription.close();
    await client.close();

    // The socket that carried the stream stays counted as in-flight even
    // though the exchange is over; without the forced close, this waits
    // seconds - most of the CLI's graceful-shutdown budget.
    const started = Date.now();

    await httpServer.close();

    expect(Date.now() - started).toBeLessThan(2500);
  }, 30000);

  it("lets an in-flight request finish before forcing sockets closed", async () => {
    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      createServer: createBareServer,
      onUnhandledRequest: async (req, res) => {
        if (req.url !== "/slow") {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 600));

        res.writeHead(200).end("done");
      },
      port,
    });

    const inflight = fetch(`http://127.0.0.1:${port}/slow`);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await httpServer.close();

    expect(await (await inflight).text()).toBe("done");
  }, 30000);
});

describe("resource subscriptions from a 2026-07-28 client", () => {
  it("propagates the listen filter's URIs and releases them on stream close", async () => {
    const acquired: string[][] = [];
    let released = 0;

    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      createServer: createBareServer,
      onListenSubscriptions: async (uris) => {
        acquired.push(uris);

        return () => {
          released++;
        };
      },
      port,
    });

    try {
      const client = await connect(port, "modern");

      // That revision has no `resources/subscribe`; the URIs ride the listen
      // filter, which the SDK puts on the wire as `params.notifications`.
      const subscription = await client.listen({
        resourceSubscriptions: ["file:///watched.txt"],
        toolsListChanged: true,
      });

      expect(acquired).toEqual([["file:///watched.txt"]]);

      await subscription.close();
      await client.close();

      // Held for the life of the stream, then given back.
      await vi.waitFor(() => {
        expect(released).toBe(1);
      });
    } finally {
      await httpServer.close();
    }
  }, 30000);

  it("delivers an upstream resources/updated for a subscribed URI", async () => {
    const { port } = await startProxy({ fixture: "dual-era-stdio-server.ts" });

    const client = await connect(port, "modern");

    const updates: string[] = [];

    client.setNotificationHandler(
      "notifications/resources/updated",
      async (notification) => {
        updates.push(notification.params.uri);
      },
    );

    const subscription = await client.listen({
      resourceSubscriptions: ["file:///watched.txt"],
    });

    await client.callTool({
      arguments: { uri: "file:///watched.txt" },
      name: "trigger-resource-updated",
    });

    // The full loop: listen filter -> upstream `resources/subscribe` -> the
    // upstream notification -> the proxy's bus -> this client's stream.
    await vi.waitFor(() => {
      expect(updates).toEqual(["file:///watched.txt"]);
    });

    await subscription.close();
    await client.close();
  }, 30000);

  it("releases the instance when the subscription hook fails", async () => {
    let created = 0;
    let closed = 0;

    const port = await getRandomPort();
    const httpServer = await startHTTPServer({
      createServer: async () => {
        created++;

        return createBareServer();
      },
      onClose: async () => {
        closed++;
      },
      onListenSubscriptions: async () => {
        throw new Error("upstream refused the subscription");
      },
      port,
    });

    try {
      const client = await connect(port, "modern");

      await expect(
        client.listen({ resourceSubscriptions: ["file:///nope.txt"] }),
      ).rejects.toThrow();

      await client.close();

      // The instance was built before the hook ran, so a throw there must not
      // strand it - nothing downstream of `createInstance` would ever close it.
      expect(created).toBeGreaterThan(0);
      expect(closed).toBe(created);
    } finally {
      await httpServer.close();
    }
  }, 30000);
});

describe("modern leg request validation", () => {
  it("answers 415 when a modern-looking POST is not JSON", async () => {
    const { port } = await startProxy({ fixture: "simple-stdio-server.ts" });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "text/plain",
      },
      method: "POST",
    });

    expect(response.status).toBe(415);
  }, 30000);
});
