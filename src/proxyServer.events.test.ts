import type {
  JSONObject,
  ServerContext,
  StandardSchemaV1,
} from "@modelcontextprotocol/server";

import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  ProtocolError,
  Server,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getRandomPort } from "get-port-please";
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProxyServer } from "./createProxyServer.js";
import { EVENTS_EXTENSION } from "./eventsExtension.js";
import { proxyServer } from "./proxyServer.js";
import { startHTTPServer } from "./startHTTPServer.js";
import {
  resolveVersionNegotiation,
  UpstreamProtocol,
} from "./startStdioServer.js";
import { StdioClientTransport } from "./StdioClientTransport.js";

/**
 * MCP Events (SEP-3415) across the proxy: the request/response methods behind
 * webhook and poll delivery, forwarded to the upstream as they arrived.
 *
 * Most cases use an in-process upstream, so a test can see exactly what
 * reached it and when its handler was cancelled. The last group spawns a real
 * stdio server, the way the CLI runs one.
 */

const ERAS = ["legacy", "modern"] as const;

type Era = (typeof ERAS)[number];

type Params = Record<string, unknown>;

/** Takes a JSON object as it is, so an assertion sees every field relayed. */
const anyObject: StandardSchemaV1<Params> = {
  "~standard": {
    validate: (value) => ({ value: value as Params }),
    vendor: "events-test",
    version: 1,
  },
};

const CALLBACK_URL = "https://hooks.example.com/mcp/client-1";

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

const INCIDENT_CREATED = {
  delivery: ["webhook", "poll"],
  description: "Fires when a new incident is created",
  inputSchema: {
    properties: { severity: { enum: ["P1", "P2"], type: "string" } },
    type: "object",
  },
  name: "incident.created",
  payloadSchema: {
    properties: { incidentId: { type: "string" } },
    type: "object",
  },
  "x-vendor": { owner: "ops" },
};

const EMAIL_RECEIVED = {
  _meta: { "com.example/stability": "beta" },
  delivery: ["poll"],
  inputSchema: { type: "object" },
  name: "email.received",
  payloadSchema: { type: "object" },
};

const LIST_PAGE_ONE = {
  _meta: { "com.example/page": 1 },
  events: [INCIDENT_CREATED],
  nextCursor: "page-2",
};

const LIST_PAGE_TWO = { events: [EMAIL_RECEIVED] };

const POLL_FROM_NOW = {
  cursor: "c-1",
  events: [],
  hasMore: false,
  nextPollMs: 30_000,
  truncated: false,
};

const POLL_BACKLOG = {
  events: [
    {
      _meta: { "com.example/source": "pagerduty" },
      data: { incidentId: "INC-1234", reporter: null },
      eventId: "evt_789",
      name: "incident.created",
      timestamp: "2026-11-04T16:00:00Z",
    },
  ],
  hasMore: true,
  nextPollMs: 5_000,
  truncated: true,
  "x-vendor": { region: "eu" },
};

type Call = { id: unknown; method: string; params: Params };

type InProcessUpstream = {
  /** Upstream ids of the requests whose handler saw its signal abort. */
  aborted: unknown[];
  /** Every `events/*` request the upstream received, in arrival order. */
  calls: Call[];
} & Upstream;

type Upstream = {
  client: Client;
  close: () => Promise<void>;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * An upstream in this process, served by `serveStdio` over a linked in-memory
 * pair: unlike a bare `Server.connect()`, that answers `server/discover`, so it
 * can be reached in either era.
 *
 * `events` is the extension's settings object, or `null` to not advertise it.
 * The handlers are registered either way, so a "method not found" can only
 * come from the proxy.
 */
const createUpstream = async ({
  era,
  events = {},
}: {
  era: Era;
  events?: JSONObject | null;
}): Promise<InProcessUpstream> => {
  const aborted: unknown[] = [];
  const calls: Call[] = [];
  const subscriptions = new Map<string, number>();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const handle = serveStdio(
    () => {
      const server = new Server(
        { name: "events-upstream", version: "1.0.0" },
        {
          capabilities: {
            ...(events === null
              ? {}
              : { extensions: { [EVENTS_EXTENSION]: events } }),
            prompts: {},
            resources: {},
            tools: { listChanged: true },
          },
        },
      );

      const answer = (
        method: string,
        handler: (params: Params, ctx: ServerContext) => Promise<Params>,
      ) => {
        server.setRequestHandler(
          method,
          { params: anyObject },
          (params, ctx) => {
            calls.push({
              id: ctx.mcpReq.id,
              method,
              params: structuredClone(params),
            });

            return handler(params, ctx);
          },
        );
      };

      answer("events/list", async (params) =>
        params.cursor === "page-2" ? LIST_PAGE_TWO : LIST_PAGE_ONE,
      );

      answer("events/poll", async (params, ctx) => {
        if (params.name === "missing") {
          throw new ProtocolError(-32023, "Unknown event: missing", {
            kind: "event",
          });
        }

        const progressToken = ctx.mcpReq._meta?.progressToken;

        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progress: 1, progressToken, total: 2 },
          });
        }

        const options = (params.arguments ?? {}) as {
          delayMs?: number;
          hang?: boolean;
        };

        if (options.hang) {
          await new Promise<void>((resolve) => {
            ctx.mcpReq.signal.addEventListener("abort", () => {
              aborted.push(ctx.mcpReq.id);
              resolve();
            });
          });
        }

        if (options.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }

        // A cursor the response can be traced back to, so correlation is
        // checkable: each resumed poll answers `<its cursor>+1`.
        return params.cursor === null || params.cursor === undefined
          ? POLL_FROM_NOW
          : { ...POLL_BACKLOG, cursor: `${params.cursor}+1` };
      });

      answer("events/subscribe", async (params) => {
        const delivery = params.delivery as { secret?: unknown; url?: unknown };

        if (
          typeof delivery.secret !== "string" ||
          !delivery.secret.startsWith("whsec_")
        ) {
          throw new ProtocolError(
            -32602,
            "delivery.secret must be a whsec_ secret",
            { field: "delivery.secret" },
          );
        }

        // One principal - this process - so the key is the rest of the tuple.
        const key = JSON.stringify([
          delivery.url,
          params.name,
          params.arguments,
        ]);
        const count = (subscriptions.get(key) ?? 0) + 1;

        subscriptions.set(key, count);

        return {
          cursor: "cursor_start_001",
          ...(count > 1
            ? {
                deliveryStatus: {
                  active: true,
                  lastDeliveryAt: null,
                  lastError: null,
                },
              }
            : {}),
          id: `sub_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
          refreshBefore:
            params.ttlMs === null ? null : "2026-11-05T12:00:00.000Z",
          truncated: false,
        };
      });

      answer("events/unsubscribe", async () => ({}));
      answer("events/stream", async () => ({}));

      server.setRequestHandler("tools/list", async () => ({
        tools: [
          {
            inputSchema: { properties: {}, type: "object" as const },
            name: "lookup_incident",
          },
        ],
      }));
      server.setRequestHandler("tools/call", async (request) => ({
        content: [
          { text: `called ${request.params.name}`, type: "text" as const },
        ],
      }));
      server.setRequestHandler("resources/list", async () => ({
        resources: [{ name: "Runbook", uri: "file:///runbook.md" }],
      }));
      server.setRequestHandler("resources/read", async (request) => ({
        contents: [{ text: "# Runbook", uri: request.params.uri }],
      }));
      server.setRequestHandler("prompts/list", async () => ({
        prompts: [{ name: "triage" }],
      }));
      server.setRequestHandler("prompts/get", async () => ({
        messages: [
          {
            content: { text: "Triage the incident", type: "text" as const },
            role: "user" as const,
          },
        ],
      }));

      return server;
    },
    { transport: serverTransport },
  );

  const client = new Client(
    { name: "mcp-proxy", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: resolveVersionNegotiation(era) },
  );

  await client.connect(clientTransport);

  expect(client.getProtocolEra()).toBe(era);

  // Spends request id 0 before any test traffic. A 2026-07-28 connection
  // hands id 0 to the first request after `server/discover` (a 2025-era one
  // spends it on `initialize`), and SDK 2.0.0 drops a `notifications/cancelled`
  // naming id 0 - `_oncancel` tests `!requestId`. Left as is, the first
  // forwarded call could not be cancelled upstream whatever the proxy did.
  await client.listTools();

  return {
    aborted,
    calls,
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
};

/** A stdio server spawned the way the CLI spawns one. */
const spawnUpstream = async ({
  env,
  upstreamProtocol,
}: {
  env?: Record<string, string>;
  upstreamProtocol: UpstreamProtocol;
}): Promise<Upstream> => {
  const client = new Client(
    { name: "mcp-proxy", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: resolveVersionNegotiation(upstreamProtocol),
    },
  );

  await client.connect(
    new StdioClientTransport({
      args: ["src/fixtures/events-stdio-server.ts"],
      command: "tsx",
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "inherit",
    }),
  );

  return { client, close: () => client.close() };
};

/**
 * The CLI's wiring - `createProxyServer`, then `proxyServer` - so what a
 * client sees is what `mcp-proxy` advertises. `unhandled` collects every
 * request that reached the proxy outside its MCP endpoints, and `closed` the
 * protocol version of every downstream instance torn down.
 *
 * Bound to the address the clients dial. Without a host, `getRandomPort` never
 * checks loopback, and a bind to the default `::` succeeds beside a service
 * already listening on `127.0.0.1` at that port - which then gets this test's
 * requests.
 */
const startProxy = async (
  upstream: Upstream,
  { requestTimeout }: { requestTimeout?: number } = {},
) => {
  const closed: (string | undefined)[] = [];
  const unhandled: string[] = [];
  const port = await getRandomPort("127.0.0.1");

  const httpServer = await startHTTPServer({
    createServer: async () => {
      const { server, serverCapabilities } = createProxyServer(upstream.client);

      await proxyServer({
        client: upstream.client,
        requestTimeout,
        server,
        serverCapabilities,
      });

      return server;
    },
    host: "127.0.0.1",
    onClose: async (server) => {
      closed.push(server.getNegotiatedProtocolVersion());
    },
    onUnhandledRequest: async (req) => {
      unhandled.push(`${req.method} ${req.url}`);
    },
    port,
  });

  cleanups.push(async () => {
    await httpServer.close();
    await upstream.close();
  });

  return { closed, port, unhandled };
};

const connect = async (port: number, era: Era) => {
  const client = new Client(
    { name: `${era}-client`, version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation:
        era === "modern" ? { mode: { pin: "2026-07-28" } } : undefined,
    },
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );

  cleanups.push(() => client.close());

  return client;
};

/**
 * A result without the `serverInfo` stamp a 2026-07-28 hop adds to `_meta`.
 * Which hop adds it depends on the two eras, not on the forward.
 */
const unstamped = (result: Params): Params => {
  const copy = structuredClone(result);
  const meta = copy._meta as Params | undefined;

  if (meta !== undefined) {
    delete meta["io.modelcontextprotocol/serverInfo"];

    if (Object.keys(meta).length === 0) {
      delete copy._meta;
    }
  }

  return copy;
};

/**
 * The JSON-RPC error code a request was refused with. A 2025-era connection
 * carries it in-band. The 2026-07-28 leg refuses a method it has no handler
 * for at the HTTP layer - a 404 whose body is that same JSON-RPC error - and
 * this SDK client surfaces that as an `SdkHttpError` holding the body.
 */
const refusal = async (request: Promise<unknown>): Promise<unknown> => {
  const error = await request.then(
    () => {
      throw new Error("expected the request to be refused");
    },
    (reason: unknown) => reason,
  );

  if (error instanceof ProtocolError) {
    return error.code;
  }

  if (error instanceof SdkHttpError && error.data?.status === 404) {
    return (JSON.parse(String(error.data.text)) as { error: { code: number } })
      .error.code;
  }

  throw error;
};

const sign = (secret: string, content: string) =>
  createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(content)
    .digest("base64");

type Delivery = {
  body: string;
  headers: http.IncomingHttpHeaders;
  path: string | undefined;
};

/**
 * The caller's own webhook endpoint. It echoes a verification challenge only
 * once `release` is called, so a test can look at a delivery while the
 * subscribe that caused it is still waiting on the answer. Checking the
 * signature is left to the test, where a mismatch says what went wrong.
 */
const startReceiver = async () => {
  const deliveries: Delivery[] = [];

  let release = () => {};

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");

      deliveries.push({ body, headers: req.headers, path: req.url });

      void released.then(() => {
        const { challenge } = JSON.parse(body) as { challenge?: string };

        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ challenge }));
      });
    });
  });

  const port = await getRandomPort("127.0.0.1");

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  return {
    deliveries,
    release: () => release(),
    url: `http://127.0.0.1:${port}/hooks/client-1`,
  };
};

describe("capability gating", () => {
  for (const clientEra of ERAS) {
    it(`answers events/* itself when the upstream does not advertise the extension (${clientEra} client)`, async () => {
      const upstream = await createUpstream({ era: "modern", events: null });
      const { port } = await startProxy(upstream);
      const client = await connect(port, clientEra);

      expect(client.getServerCapabilities()?.extensions).toBeUndefined();

      for (const method of [
        "events/list",
        "events/poll",
        "events/subscribe",
        "events/unsubscribe",
      ]) {
        expect(
          await refusal(
            client.request(
              { method, params: { name: "incident.created" } },
              anyObject,
            ),
          ),
        ).toBe(-32601);
      }

      expect(upstream.calls).toEqual([]);
    }, 30000);
  }

  it("advertises listChanged as false, keeps the other settings, and leaves the upstream's object alone", async () => {
    const settings = {
      listChanged: true,
      "x-vendor": { feeds: ["github", "stripe"], since: null },
    };
    const upstream = await createUpstream({ era: "modern", events: settings });
    const { port } = await startProxy(upstream);
    const [legacy, modern] = await Promise.all([
      connect(port, "legacy"),
      connect(port, "modern"),
    ]);

    // Nothing relays `notifications/events/list_changed`, so neither era may
    // be told it will arrive.
    for (const client of [legacy, modern]) {
      expect(
        client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
      ).toStrictEqual({ ...settings, listChanged: false });
    }

    // The client's own object - which every later downstream server is built
    // from - still says what the upstream said.
    expect(
      upstream.client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
    ).toStrictEqual(settings);
  }, 30000);

  it("does not acknowledge eventsListChanged on a listen stream", async () => {
    const upstream = await createUpstream({
      era: "modern",
      events: { listChanged: true },
    });
    const { port } = await startProxy(upstream);
    const client = await connect(port, "modern");

    // The serving entry builds the acknowledgement, not the proxy, and nothing
    // here relays `notifications/events/list_changed` - so this guards against
    // an SDK that starts echoing the field promising what never arrives.
    const filter = { eventsListChanged: true, toolsListChanged: true };
    const subscription = await client.listen(filter);

    expect(subscription.honoredFilter).toStrictEqual({
      toolsListChanged: true,
    });

    await subscription.close();
  }, 30000);

  for (const clientEra of ERAS) {
    it(`leaves events/stream at method not found instead of forwarding it (${clientEra} client)`, async () => {
      const upstream = await createUpstream({ era: "modern" });
      const { port } = await startProxy(upstream);
      const client = await connect(port, clientEra);

      expect(
        await refusal(
          client.request(
            {
              method: "events/stream",
              params: { cursor: null, name: "incident.created" },
            },
            anyObject,
          ),
        ),
      ).toBe(-32601);

      expect(upstream.calls).toEqual([]);
    }, 30000);
  }
});

for (const upstreamEra of ERAS) {
  for (const clientEra of ERAS) {
    describe(`a ${clientEra} client fronting a ${upstreamEra} upstream`, () => {
      it("forwards all four methods without reshaping their params or results", async () => {
        const upstream = await createUpstream({ era: upstreamEra });
        const { port } = await startProxy(upstream);
        const client = await connect(port, clientEra);

        expect(
          client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
        ).toStrictEqual({});

        const firstPage = await client.request(
          { method: "events/list" },
          anyObject,
        );
        const secondPage = await client.request(
          { method: "events/list", params: { cursor: firstPage.nextCursor } },
          anyObject,
        );

        expect(unstamped(firstPage)).toStrictEqual(LIST_PAGE_ONE);
        expect(unstamped(secondPage)).toStrictEqual(LIST_PAGE_TWO);

        const poll = {
          _meta: { "com.example/trace": "trace-1" },
          arguments: { severity: "P1" },
          cursor: null,
          maxAgeMs: 300_000,
          maxEvents: 50,
          name: "incident.created",
        };
        const fromNow = await client.request(
          { method: "events/poll", params: poll },
          anyObject,
        );
        const resumed = await client.request(
          {
            method: "events/poll",
            params: { ...poll, cursor: fromNow.cursor },
          },
          anyObject,
        );

        expect(unstamped(fromNow)).toStrictEqual(POLL_FROM_NOW);
        expect(unstamped(resumed)).toStrictEqual({
          ...POLL_BACKLOG,
          cursor: "c-1+1",
        });

        // `ttlMs: null` asks for no expiry; leaving it out asks for the
        // server's default. The two must not collapse into each other.
        const subscribe = {
          _meta: { "com.example/trace": "trace-2" },
          arguments: { severity: "P1" },
          cursor: null,
          delivery: { mode: "webhook", secret: SECRET, url: CALLBACK_URL },
          name: "incident.created",
        };
        const subscribed = await client.request(
          {
            method: "events/subscribe",
            params: { ...subscribe, ttlMs: null },
          },
          anyObject,
        );
        const refreshed = await client.request(
          { method: "events/subscribe", params: subscribe },
          anyObject,
        );

        expect(subscribed.id).toMatch(/^sub_[0-9a-f]{16}$/);
        expect(unstamped(subscribed)).toStrictEqual({
          cursor: "cursor_start_001",
          id: subscribed.id,
          refreshBefore: null,
          truncated: false,
        });
        expect(unstamped(refreshed)).toStrictEqual({
          cursor: "cursor_start_001",
          deliveryStatus: {
            active: true,
            lastDeliveryAt: null,
            lastError: null,
          },
          id: subscribed.id,
          refreshBefore: "2026-11-05T12:00:00.000Z",
          truncated: false,
        });

        const unsubscribe = {
          arguments: { severity: "P1" },
          delivery: { url: CALLBACK_URL },
          name: "incident.created",
        };
        const unsubscribed = await client.request(
          { method: "events/unsubscribe", params: unsubscribe },
          anyObject,
        );

        expect(unstamped(unsubscribed)).toStrictEqual({});

        // What the upstream was handed: the caller's params exactly, minus
        // only the per-request envelope each hop's SDK lifts off `_meta`.
        expect(
          upstream.calls.map(({ method, params }) => ({ method, params })),
        ).toStrictEqual([
          { method: "events/list", params: {} },
          { method: "events/list", params: { cursor: "page-2" } },
          { method: "events/poll", params: poll },
          { method: "events/poll", params: { ...poll, cursor: "c-1" } },
          {
            method: "events/subscribe",
            params: { ...subscribe, ttlMs: null },
          },
          { method: "events/subscribe", params: subscribe },
          { method: "events/unsubscribe", params: unsubscribe },
        ]);
      }, 30000);

      it("passes upstream errors through with their code, message and data", async () => {
        const upstream = await createUpstream({ era: upstreamEra });
        const { port } = await startProxy(upstream);
        const client = await connect(port, clientEra);

        const poll = client.request(
          {
            method: "events/poll",
            params: { cursor: null, name: "missing" },
          },
          anyObject,
        );

        await expect(poll).rejects.toBeInstanceOf(ProtocolError);
        await expect(poll).rejects.toMatchObject({
          code: -32023,
          data: { kind: "event" },
          message: "Unknown event: missing",
        });

        await expect(
          client.request(
            {
              method: "events/subscribe",
              params: {
                delivery: { secret: "hunter2", url: CALLBACK_URL },
                name: "incident.created",
              },
            },
            anyObject,
          ),
        ).rejects.toMatchObject({
          code: -32602,
          data: { field: "delivery.secret" },
          message: "delivery.secret must be a whsec_ secret",
        });
      }, 30000);

      it("relays progress under the token the caller chose", async () => {
        const upstream = await createUpstream({ era: upstreamEra });
        const { port } = await startProxy(upstream);
        const client = await connect(port, clientEra);

        const tokens: unknown[] = [];

        client.setNotificationHandler(
          "notifications/progress",
          async (notification) => {
            tokens.push(notification.params.progressToken);
          },
        );

        await client.request(
          {
            method: "events/poll",
            params: {
              _meta: { progressToken: "downstream-token" },
              cursor: null,
              name: "incident.created",
            },
          },
          anyObject,
        );

        await vi.waitFor(() => {
          expect(tokens).toEqual(["downstream-token"]);
        });

        // Upstream, the call carries the proxy's own token: two callers'
        // tokens could collide there, and the upstream SDK matches its
        // progress by the token it was given.
        const [call] = upstream.calls;

        expect(call.params._meta).toStrictEqual({
          progressToken: expect.any(Number),
        });
      }, 30000);

      it("propagates the caller's cancellation upstream", async () => {
        const upstream = await createUpstream({ era: upstreamEra });
        const { port } = await startProxy(upstream);
        const client = await connect(port, clientEra);

        const abort = new AbortController();
        const poll = client.request(
          {
            method: "events/poll",
            params: {
              arguments: { hang: true },
              cursor: null,
              name: "incident.created",
            },
          },
          anyObject,
          { signal: abort.signal },
        );

        // Only once the upstream is working on it is there anything to cancel.
        await vi.waitFor(() => {
          expect(upstream.calls).toHaveLength(1);
        });

        abort.abort();

        await expect(poll).rejects.toThrow();

        await vi.waitFor(() => {
          expect(upstream.aborted).toEqual([upstream.calls[0].id]);
        });
      }, 30000);
    });
  }
}

describe("request lifetime", () => {
  for (const clientEra of ERAS) {
    it(`applies the configured request timeout and cancels the upstream call (${clientEra} client)`, async () => {
      const upstream = await createUpstream({ era: "modern" });
      const { port } = await startProxy(upstream, { requestTimeout: 300 });
      const client = await connect(port, clientEra);

      // The SDK's own default is 60 s; `data.timeout` is the configured value.
      await expect(
        client.request(
          {
            method: "events/poll",
            params: {
              arguments: { hang: true },
              cursor: null,
              name: "incident.created",
            },
          },
          anyObject,
        ),
      ).rejects.toMatchObject({
        data: { timeout: 300 },
        message: "Request timed out",
      });

      await vi.waitFor(() => {
        expect(upstream.aborted).toHaveLength(1);
      });
    }, 30000);
  }

  it("answers each caller with its own response when upstream replies cross", async () => {
    const upstream = await createUpstream({ era: "modern" });
    const { port } = await startProxy(upstream);
    const [first, second, third] = await Promise.all([
      connect(port, "legacy"),
      connect(port, "legacy"),
      connect(port, "modern"),
    ]);

    // Every client numbers its requests from the same start, so their ids
    // collide; the delays make the upstream answer in reverse arrival order.
    const poll = (client: Client, cursor: string, delayMs: number) =>
      client.request(
        {
          method: "events/poll",
          params: { arguments: { delayMs }, cursor, name: "incident.created" },
        },
        anyObject,
      );

    const results = await Promise.all([
      poll(first, "first-a", 450),
      poll(first, "first-b", 300),
      poll(second, "second", 150),
      poll(third, "third", 0),
    ]);

    expect(results.map((result) => result.cursor)).toEqual([
      "first-a+1",
      "first-b+1",
      "second+1",
      "third+1",
    ]);

    // Upstream, the proxy's own client numbered them: one id per request.
    const ids = upstream.calls.map((call) => call.id);

    expect(new Set(ids).size).toBe(4);
  }, 30000);
});

describe("subscriptions belong to the upstream", () => {
  it("forwards every subscribe and unsubscribe, and unsubscribes nothing when callers leave", async () => {
    const upstream = await createUpstream({ era: "modern" });
    const { closed, port } = await startProxy(upstream);
    const [legacy, modern] = await Promise.all([
      connect(port, "legacy"),
      connect(port, "modern"),
    ]);

    const subscribe = {
      arguments: { severity: "P1" },
      delivery: { mode: "webhook", secret: SECRET, url: CALLBACK_URL },
      name: "incident.created",
    };
    const unsubscribe = {
      arguments: { severity: "P1" },
      delivery: { url: CALLBACK_URL },
      name: "incident.created",
    };

    const created = await legacy.request(
      { method: "events/subscribe", params: subscribe },
      anyObject,
    );
    const refreshed = await legacy.request(
      { method: "events/subscribe", params: subscribe },
      anyObject,
    );
    const fromAnotherCaller = await modern.request(
      { method: "events/subscribe", params: subscribe },
      anyObject,
    );

    // Only the upstream tells a refresh from a new subscription. It sees one
    // principal behind the proxy, so the second caller's subscribe is a
    // refresh of the first caller's subscription.
    expect(created.deliveryStatus).toBeUndefined();
    expect(refreshed.deliveryStatus).toBeDefined();
    expect(fromAnotherCaller.deliveryStatus).toBeDefined();

    await legacy.request(
      { method: "events/unsubscribe", params: unsubscribe },
      anyObject,
    );
    await legacy.request(
      { method: "events/unsubscribe", params: unsubscribe },
      anyObject,
    );

    // `close()` alone sends no DELETE, so the 2025-era session would outlive
    // the test untouched. Ending it is what tears its server instance down.
    await (
      legacy.transport as StreamableHTTPClientTransport
    ).terminateSession();
    await legacy.close();
    await modern.close();

    await vi.waitFor(() => {
      expect(
        closed.some(
          (version) => version !== undefined && version < "2026-07-28",
        ),
      ).toBe(true);
    });

    // Room for anything that teardown might still send upstream.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(upstream.calls.map((call) => call.method)).toEqual([
      "events/subscribe",
      "events/subscribe",
      "events/subscribe",
      "events/unsubscribe",
      "events/unsubscribe",
    ]);
  }, 30000);
});

describe("next to the core primitives", () => {
  for (const clientEra of ERAS) {
    it(`still serves tools, resources and prompts (${clientEra} client)`, async () => {
      const upstream = await createUpstream({ era: "modern" });
      const { port } = await startProxy(upstream);
      const client = await connect(port, clientEra);

      const tools = await client.listTools();
      const called = await client.callTool({
        arguments: {},
        name: "lookup_incident",
      });
      const resources = await client.listResources();
      const read = await client.readResource({ uri: "file:///runbook.md" });
      const prompts = await client.listPrompts();
      const prompt = await client.getPrompt({ name: "triage" });
      const events = await client.request({ method: "events/list" }, anyObject);

      expect(tools.tools.map((tool) => tool.name)).toEqual(["lookup_incident"]);
      expect(called.content).toEqual([
        { text: "called lookup_incident", type: "text" },
      ]);
      expect(resources.resources).toEqual([
        { name: "Runbook", uri: "file:///runbook.md" },
      ]);
      expect(read.contents).toEqual([
        { text: "# Runbook", uri: "file:///runbook.md" },
      ]);
      expect(prompts.prompts).toEqual([{ name: "triage" }]);
      expect(prompt.messages).toEqual([
        {
          content: { text: "Triage the incident", type: "text" },
          role: "user",
        },
      ]);
      expect(events.events).toHaveLength(1);
    }, 30000);
  }
});

describe("a stdio upstream behind the HTTP endpoint", () => {
  it("lets a 2026-07-28 upstream POST a webhook to the caller while the subscribe is in flight", async () => {
    const receiver = await startReceiver();
    // `reject` makes the fixture refuse a 2025-era opening, so the era below
    // is proof of negotiation rather than a silent fallback.
    const upstream = await spawnUpstream({
      env: { MCP_FIXTURE_LEGACY: "reject" },
      upstreamProtocol: "modern",
    });

    expect(upstream.client.getProtocolEra()).toBe("modern");

    const { port, unhandled } = await startProxy(upstream);
    const client = await connect(port, "modern");

    expect(
      client.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
    ).toStrictEqual({});

    const listed = await client.request({ method: "events/list" }, anyObject);

    expect(listed.events).toMatchObject([{ name: "incident.created" }]);

    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const subscribe = {
      _meta: { "com.example/trace": "trace-3" },
      arguments: { severity: "P1" },
      cursor: null,
      delivery: { mode: "webhook", secret, url: receiver.url },
      name: "incident.created",
      ttlMs: null,
    };

    let settled = false;

    const subscribing = client
      .request({ method: "events/subscribe", params: subscribe }, anyObject)
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(
      () => {
        expect(receiver.deliveries).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    // The webhook has arrived and its subscribe is still unanswered: the
    // upstream is waiting on this receiver, which it reached directly.
    expect(settled).toBe(false);

    const [delivery] = receiver.deliveries;

    expect(delivery.path).toBe("/hooks/client-1");
    expect(JSON.parse(delivery.body)).toMatchObject({ type: "verification" });

    // Signed with the secret this client generated, so it crossed intact.
    expect(delivery.headers["webhook-signature"]).toBe(
      `v1,${sign(
        secret,
        `${delivery.headers["webhook-id"]}.${delivery.headers["webhook-timestamp"]}.${delivery.body}`,
      )}`,
    );

    receiver.release();

    const subscribed = await subscribing;

    expect(subscribed.id).toBe(delivery.headers["x-mcp-subscription-id"]);
    expect(subscribed.echo).toStrictEqual(subscribe);

    const polled = await client.request(
      {
        method: "events/poll",
        params: { cursor: null, name: "incident.created" },
      },
      anyObject,
    );
    const unsubscribed = await client.request(
      {
        method: "events/unsubscribe",
        params: {
          arguments: { severity: "P1" },
          delivery: { url: receiver.url },
          name: "incident.created",
        },
      },
      anyObject,
    );

    expect(polled).toMatchObject({
      cursor: "cursor_after_poll",
      echo: { cursor: null, name: "incident.created" },
    });
    expect(unsubscribed.echo).toStrictEqual({
      arguments: { severity: "P1" },
      delivery: { url: receiver.url },
      name: "incident.created",
    });

    // The proxy has no route a webhook could take, and nothing tried one.
    expect(receiver.deliveries).toHaveLength(1);
    expect(unhandled).toEqual([]);
  }, 30000);

  it("needs --upstreamProtocol auto or modern to see an extension offered only on 2026-07-28", async () => {
    // A server advertising the extension only where SEP-3415 defines it.
    const env = { MCP_FIXTURE_EVENTS_LEGACY: "hide" };
    const [byDefault, probed] = await Promise.all([
      spawnUpstream({ env, upstreamProtocol: "legacy" }),
      spawnUpstream({ env, upstreamProtocol: "auto" }),
    ]);

    expect(byDefault.client.getProtocolEra()).toBe("legacy");
    expect(probed.client.getProtocolEra()).toBe("modern");

    const [behindDefault, behindProbed] = await Promise.all([
      startProxy(byDefault).then(({ port }) => connect(port, "modern")),
      startProxy(probed).then(({ port }) => connect(port, "modern")),
    ]);

    // The 2025 handshake never shows the proxy the extension, so it answers
    // events/* itself - though the server behind it would have answered.
    expect(behindDefault.getServerCapabilities()?.extensions).toBeUndefined();
    expect(
      await refusal(
        behindDefault.request({ method: "events/list" }, anyObject),
      ),
    ).toBe(-32601);

    expect(
      behindProbed.getServerCapabilities()?.extensions?.[EVENTS_EXTENSION],
    ).toStrictEqual({});
    await expect(
      behindProbed.request({ method: "events/list" }, anyObject),
    ).resolves.toMatchObject({ events: [{ name: "incident.created" }] });
  }, 30000);
});
