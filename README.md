# MCP Proxy

A TypeScript streamable HTTP and SSE proxy for [MCP](https://modelcontextprotocol.io/) servers that use `stdio` transport.

> [!NOTE]
> CORS is enabled by default with configurable options. See [CORS Configuration](#cors-configuration) for details.

> [!NOTE]
> For a Python implementation, see [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

> [!NOTE]
> MCP Proxy is what [FastMCP](https://github.com/punkpeye/fastmcp) uses to enable streamable HTTP and SSE.

## Protocol revisions

MCP Proxy serves protocol revision `2026-07-28` and the 2025-era revisions
(`2024-10-07` through `2025-11-25`) from the same endpoint. Every POST to the
streamable HTTP endpoint is classified by its own content — the 2026-07-28
revision puts a `_meta` envelope on every request, and requests without one are
served by the 2025-era session machinery — so old and new clients share one URL
and neither has to know the other exists.

|                       | 2025-era clients | 2026-07-28 clients            |
| --------------------- | ---------------- | ----------------------------- |
| `/mcp` (streamable)   | yes, sessionful  | yes, per-request              |
| `/sse` (HTTP+SSE)     | yes              | n/a — no SSE transport exists |
| stdio (`startStdioServer`) | yes         | not yet — see below           |
| Change notifications  | unsolicited      | `subscriptions/listen` stream |

Progress notifications and cancellation cross the proxy in both eras: a
forwarded call carries the caller's abort signal, and relayed progress is
re-tagged with the token the caller sent.

Use `--no-modern` to serve only 2025-era clients; a 2026-07-28 client is then
answered by the 2025-era machinery, which does not recognise its request. The
modern leg lives on the streamable HTTP endpoint, so it is also absent when that
endpoint is disabled (`--server sse`, or `streamEndpoint: null`).

The upstream connection — the server MCP Proxy spawns — negotiates its own
revision independently, so any combination works. It uses the 2025 `initialize`
handshake by default; pass `--upstreamProtocol auto` to probe with
`server/discover` first (needed to front a 2026-07-28 server) or
`--upstreamProtocol modern` to require it.

```bash
# front a 2026-07-28 stdio server, serving both eras downstream
npx mcp-proxy --upstreamProtocol auto -- my-modern-mcp-server
```

### What does not cross the proxy

These are consequences of one design decision — the proxy multiplexes every
downstream connection onto a **single** upstream connection — and are called out
rather than half-solved.

- **Anything that asks the client for input** (elicitation, sampling, roots).
  A 2025-era server pushes its request out of band, carrying nothing that says
  which caller it belongs to, so relaying it means guessing whose screen to put
  the prompt on. A 2026-07-28 upstream is not ambiguous that way — the request
  comes back as the `input_required` result of the call the proxy forwarded —
  so that direction is a question of scope, not correlation. Not implemented
  yet.
- **Log messages, on both sides of a 2026-07-28 connection.** That revision
  carries logs per request: the client asks in a request's `_meta`, the server
  answers on that request's stream. The proxy can do neither half — downstream
  it has no per-request log callback and its notification handlers are passed
  nothing to attribute a log to; upstream it cannot ask for logs at all, so a
  2026-07-28 server's per-request logging never fires. 2025-era clients still
  get the deprecated unsolicited path: everything from a 2025-era upstream, and
  from a 2026-07-28 upstream only what it sends outside the per-request
  channel, which a conformant one will not use.
- **`logging/setLevel` upstream.** Answered and honored per downstream
  connection — messages below the level a connection asked for are not
  forwarded to it — but never passed on: the shared upstream carries one level,
  so forwarding would let one client silence another's logs, and the method
  does not exist on a 2026-07-28 upstream at all.
- **Client identity.** The upstream sees `mcp-proxy` as its client, not the
  downstream caller — so does any telemetry keyed on it.
- **2026-07-28 over stdio.** `startStdioServer` serves 2025-era clients only;
  the HTTP side serves both.

> [!NOTE]
> The `/sse` endpoint uses the frozen `@modelcontextprotocol/server-legacy`
> copy of the HTTP+SSE transport, which the v2 SDK removed. That transport is
> deprecated as of `2026-07-28` with a twelve-month window; migrate clients to
> the streamable HTTP endpoint.

## Installation

```bash
npm install mcp-proxy
```

## Quickstart

### Command-line

```bash
# no mcp-proxy options
npx mcp-proxy npx -y @anthropic/mcp-server-filesystem /path

# with mcp-proxy options
npx mcp-proxy --port 8080 --shell -- tsx server.js
```

The second spawns `tsx server.js` over `stdio` and serves it on port 8080 at `/mcp` (streamable HTTP) and `/sse` (SSE).

> [!NOTE]
> **About the `--` separator:**
> - The `--` separator is **optional** when you don't need to pass options to mcp-proxy
> - Use `--` when you need to pass options to mcp-proxy (like `--port`, `--shell`, etc.) to clearly separate them from the command
> - Without `--`, the first positional argument is treated as the command, and all subsequent arguments are passed to that command
> - The `--` separator is also useful when the command itself has flags that might conflict with mcp-proxy options

options:

- `--server`: Set to `sse` or `stream` to only enable the respective transport (default: both)
- `--endpoint`: If `server` is set to `sse` or `stream`, this option sets the endpoint path (default: `/sse` or `/mcp`)
- `--sseEndpoint`: Set the SSE endpoint path (default: `/sse`). Overrides `--endpoint` if `server` is set to `sse`.
- `--streamEndpoint`: Set the streamable HTTP endpoint path (default: `/mcp`). Overrides `--endpoint` if `server` is set to `stream`.
- `--stateless`: Create a fresh server instance per request instead of maintaining sessions. Applies to the 2025-era leg; 2026-07-28 is per-request by construction.
- `--modern`: Serve protocol revision 2026-07-28 on the streamable HTTP endpoint alongside the 2025-era revisions (default: `true`). Use `--no-modern` to serve only 2025-era clients. See [Protocol revisions](#protocol-revisions).
- `--upstreamProtocol`: Which protocol revision to speak to the spawned server — `legacy` (default), `auto`, or `modern`. See [Protocol revisions](#protocol-revisions).
- `--port`: Specify the port to listen on (default: 8080)
- `--connectionTimeout`: Timeout in milliseconds for the initial connection to the MCP server (default: 60000)
- `--requestTimeout`: Timeout in milliseconds for requests to the MCP server (default: 300000)
- `--keepAliveTimeout`: HTTP keep-alive timeout in milliseconds for stateful stream sessions (default: 300000)
- `--eventStore`: Enable the resumability event store, letting clients replay missed messages after a reconnect (default: `true`). `--no-eventStore` disables it. See [Resumability and memory use](#resumability-and-memory-use).
- `--eventStoreMaxEvents`: Maximum number of buffered events the resumability event store retains per session before it evicts the oldest (default: 1000). Ignored when `--no-eventStore` is set.
- `--maxBodySize`: Maximum request body size in bytes accepted by the streamable HTTP endpoint; larger requests are answered with `413 Payload Too Large` (default: 10485760, 10 MiB). Set to `0` to disable the limit. See [Request body size](#request-body-size).
- `--debug`: Enable debug logging
- `--shell`: Spawn the server via the user's shell
- `--apiKey`: API key for authenticating requests (uses X-API-Key header)
- `--sslCa`: Filename to override the trusted CA certificates
- `--sslCert`: Cert chains filename in PEM format
- `--sslKey`: Private keys filename in PEM format
- `--tunnel`: Expose the proxy via a public tunnel (see [Public Tunnel](#public-tunnel))
- `--tunnelSubdomain`: Request a specific subdomain for the tunnel (availability not guaranteed)
- `--corsAddAllowedHeader`: Add a header name to `Access-Control-Allow-Headers` (defaults preserved). Repeat to add multiple. Useful when running with `--apiKey` so browser preflights for `X-API-Key` succeed.

### Troubleshooting Python stdio servers

If a Python stdio server times out with `Expected server to respond to ping`, run Python unbuffered — buffered stdout can delay JSON-RPC messages long enough for the proxy to treat the server as unresponsive:

```bash
npx mcp-proxy -- python -u -m your_package.mcp_server
# or: PYTHONUNBUFFERED=1 npx mcp-proxy -- python -m your_package.mcp_server
```

stdio servers should also reserve stdout for protocol messages — send diagnostics to stderr, and use `--debug` for proxy-side logs.

### Public Tunnel

Expose a local server to the public internet — useful for testing webhooks, sharing a dev server, or remote access.

```bash
npx mcp-proxy --port 8080 --tunnel -- tsx server.js

# request a specific subdomain
npx mcp-proxy --port 8080 --tunnel --tunnelSubdomain myapp -- tsx server.js
```

When the tunnel is established, you'll see a message like:

```
tunnel established at https://abcdefghij.tunnel.gla.ma
```

> [!NOTE]
> The requested subdomain may not be available. The actual URL will be displayed when the tunnel is established.

Powered by [pipenet](https://github.com/punkpeye/pipenet), sponsored by [glama.ai](https://glama.ai) — see the [announcement](https://glama.ai/blog/2026-01-19-pipenet).

### Stateless Mode

By default each client connection holds a server instance for the life of its session. `--stateless` creates a fresh instance per request instead, so requests are fully independent — which suits serverless platforms, load-balanced deployments, and anywhere you'd rather not hold connection state.

```bash
npx mcp-proxy --port 8080 --stateless -- tsx server.js

# stream-only transport
npx mcp-proxy --port 8080 --stateless --server stream -- tsx server.js
```

> [!NOTE]
> Stateless mode only affects HTTP streamable transport (`/mcp` endpoint). SSE transport behavior remains unchanged.

### API Key Authentication

Optional and off by default. When enabled, clients must send a valid key in the `X-API-Key` header.

```bash
npx mcp-proxy --port 8080 --apiKey "your-secret-key" -- tsx server.js

# or via the environment
export MCP_PROXY_API_KEY="your-secret-key"
npx mcp-proxy --port 8080 -- tsx server.js
```

Clients pass it as a transport header:

```typescript
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8080/mcp"),
  { headers: { "X-API-Key": "your-secret-key" } },
);
```

`/ping` and `OPTIONS` preflights are exempt. Keys travel in a header, so serve over HTTPS in production.

### CORS Configuration

#### Default Behavior

CORS is enabled by default with:

- **Origin**: `*` (allow all origins)
- **Methods**: `GET, POST, OPTIONS`
- **Headers**: `Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id, Mcp-Method, Mcp-Name`
- **Credentials**: `true`
- **Exposed Headers**: `Mcp-Session-Id`

`Mcp-Method` and `Mcp-Name` are required on 2026-07-28 streamable HTTP POSTs, so
browser clients on that revision need them allowed. That revision's
`Mcp-Param-*` headers are a prefix, which `Access-Control-Allow-Headers` cannot
express — if your tools declare `x-mcp-header` parameters, add those header
names explicitly with `--corsAddAllowedHeader` or `allowedHeaders`.

#### Configuration

`cors: true` (or omitted) uses the defaults, `cors: false` disables it, and a
`CorsOptions` object overrides individual fields:

```typescript
import { startHTTPServer, CorsOptions } from "mcp-proxy";

const cors: CorsOptions = {
  // A list, or a function for dynamic validation
  origin: ["https://app.example.com"],
  methods: ["GET", "POST", "OPTIONS"],

  // "*" allows any header — the usual fix for browser preflight failures.
  // Listing headers instead REPLACES the defaults, so restate the protocol's
  // own: dropping Mcp-Method/Mcp-Name breaks browser clients on 2026-07-28.
  allowedHeaders: "*",

  exposedHeaders: ["Mcp-Session-Id"],
  credentials: true,
  maxAge: 86400,
};

await startHTTPServer({ cors, createServer, port: 3000 });
```

Upgrading from 5.5.6 or earlier, where headers were wildcarded automatically?
Set `allowedHeaders: "*"` to restore that behavior.

#### CLI: adding allowed headers

`--corsAddAllowedHeader` appends to the default `Access-Control-Allow-Headers`
list, keeping the defaults. Repeat it to add more. The common use is unblocking
the browser preflight for a custom auth header under `--apiKey`:

```bash
npx mcp-proxy --port 8080 --apiKey secret \
  --corsAddAllowedHeader X-API-Key \
  -- npx -y @modelcontextprotocol/server-filesystem /srv
```

For origin allowlists, wildcard headers, or disabling CORS, use the
programmatic `cors` option above.

### Node.js SDK

#### `proxyServer`

Sets up a proxy between a server and a client.

```ts
const transport = new StdioClientTransport();
const client = new Client();

await client.connect(transport);

const serverCapabilities = client.getServerCapabilities();

const server = new Server(client.getServerVersion(), {
  capabilities: serverCapabilities,
});

await proxyServer({
  client,
  server,
  serverCapabilities,
});
```

In this example, the server will proxy all requests to the client and vice
versa. Handlers are registered from `serverCapabilities`, so a method the
upstream never advertised is answered "method not found" locally instead of
making a round trip to find out.

Options:

- `client`: The connected upstream client
- `server`: The downstream server to wire up
- `serverCapabilities`: What the upstream advertised; decides which handlers are registered
- `requestTimeout`: Timeout in milliseconds applied to every forwarded request (optional)

> [!NOTE]
> One `proxyServer` call serves one downstream connection, but they share a
> single upstream client, so an upstream notification is received once and
> offered to **every** connected client. Two are narrowed before they are
> forwarded: `notifications/resources/updated` reaches only the connections
> that subscribed to that URI, and `notifications/message` only those whose
> `logging/setLevel` admits it — a connection that never set one still gets
> everything. The `list_changed` notifications are not
> narrowed — they describe the one upstream, which every connection is looking
> at. If you derive per-request identity in `createServer` to serve several
> tenants from one proxy, that is the line to check against your model.

#### `startHTTPServer`

Starts a proxy that listens on a `port`, and sends messages to the attached server via `StreamableHTTPServerTransport` and `SSEServerTransport`.

```ts
import { Server } from "@modelcontextprotocol/server";
import { startHTTPServer } from "mcp-proxy";

const { close, notify } = await startHTTPServer({
  createServer: async () => {
    return new Server();
  },
  port: 8080,
  stateless: false, // Optional: enable stateless mode for streamable HTTP transport
});

close();
```

Options:

- `createServer`: Function that creates a new server instance for each connection
- `eventStore`: Event store for the streamable HTTP transport's resumability support (optional). Pass `false` to disable resumability entirely; omit to get a fresh, bounded `InMemoryEventStore` per session (see `eventStoreMaxEvents`); pass an `EventStore` instance to bring your own (e.g. persistent/cross-process), shared across all sessions. See [Resumability and memory use](#resumability-and-memory-use).
- `eventStoreMaxEvents`: Caps how many events the auto-created per-session `InMemoryEventStore` retains before evicting the oldest (default: 1000). Only applies when `eventStore` is not explicitly provided.
- `port`: Port number to listen on
- `host`: Host to bind to (default: "::")
- `keepAliveTimeout`: HTTP keep-alive timeout in milliseconds for stateful stream sessions (default: 300000)
- `maxBodySize`: Caps how many bytes of a request body the streamable HTTP endpoint buffers; larger requests are answered with `413 Payload Too Large` (default: 10485760, 10 MiB). Pass `false` to disable the cap. See [Request body size](#request-body-size).
- `sseEndpoint`: SSE endpoint path (default: "/sse", set to null to disable)
- `streamEndpoint`: Streamable HTTP endpoint path (default: "/mcp", set to null to disable)
- `stateless`: Enable stateless mode for HTTP streamable transport (default: false). Applies to the 2025-era leg; protocol revision 2026-07-28 is per-request by construction.
- `modern`: Serve protocol revision 2026-07-28 alongside the 2025-era revisions on `streamEndpoint` (default: true). See [Protocol revisions](#protocol-revisions).
- `apiKey`: API key for authenticating requests (optional)
- `cors`: CORS configuration (default: enabled with permissive settings, see CORS Configuration section)
- `onConnect`: Callback when a server instance is created (optional). Fires once per session on the 2025-era legs and **once per request** on the 2026-07-28 leg, which builds a fresh instance per request.
- `onClose`: Callback when a server instance is torn down (optional). Same per-era unit as `onConnect`; keep it cheap and idempotent.
- `onUnhandledRequest`: Callback for unhandled HTTP requests (optional)

Returns `{ close, notify }`. See [Change notifications](#change-notifications)
for what `notify` is for.

##### Change notifications

A 2025-era client receives `list_changed` and `resources/updated` unsolicited on
its own connection, and `proxyServer` forwards them there for you.

Protocol revision 2026-07-28 has no such connection: it delivers those events
only on a `subscriptions/listen` stream the client opened, and the per-request
server instances that serve it own no stream. Those events are published to the
handler's bus instead, which is what `startHTTPServer` returns as `notify`. Wire
your upstream change events to it:

```ts
import { getUpstreamBridge, startHTTPServer } from "mcp-proxy";

const { notify } = await startHTTPServer({ createServer, port: 8080 });

getUpstreamBridge({ client }).subscribe({
  promptsListChanged: () => notify.promptsChanged(),
  resourcesListChanged: () => notify.resourcesChanged(),
  resourceUpdated: ({ uri }) => notify.resourceUpdated(uri),
  toolsListChanged: () => notify.toolsChanged(),
});
```

`notify` is a no-op when `modern: false`, so this wiring is safe to leave in
place unconditionally. The `mcp-proxy` CLI does exactly this.

`getUpstreamBridge(client)` registers the upstream notification handlers once
per client and fans them out, so several downstream connections can share one
upstream server. `subscribe(sink)` returns a lease with
`addResourceSubscription` / `removeResourceSubscription` / `owns` / `release`.
Resource subscriptions are owned per lease, so one connection unsubscribing
never cancels a URI another still wants, and `release()` drops whatever a
disconnecting connection held.

A 2026-07-28 client asks for resource updates through the `resourceSubscriptions`
field of its `subscriptions/listen` filter rather than `resources/subscribe`.
Pass `onListenSubscriptions` to act on those URIs; `acquireListenSubscriptions`
is the implementation the CLI uses, and acquires them all-or-nothing so a filter
the upstream only partly accepts does not strand the rest:

```ts
import { acquireListenSubscriptions } from "mcp-proxy";

await startHTTPServer({
  createServer,
  onListenSubscriptions: (uris) => acquireListenSubscriptions({ client, uris }),
  port: 8080,
});
```

##### Resumability and memory use

The streamable HTTP transport can retain server→client messages so a client
reconnecting with a `Last-Event-ID` resumes where it left off. Each session gets
its own `InMemoryEventStore` capped at 1000 events (oldest evicted first, via
`--eventStoreMaxEvents` / `eventStoreMaxEvents`), so a long-lived session's
memory stays bounded rather than growing for the life of the process.

Don't need resume-after-reconnect? `--no-eventStore` (CLI) or
`eventStore: false` (library) drops the bookkeeping entirely. For a larger
replay window or shared storage across processes (e.g. Redis), pass your own
`EventStore` — you're then responsible for bounding its size.

##### Request body size

The streamable HTTP endpoint buffers each request body before parsing it, so a
slow-chunking client could otherwise grow the process's memory for as long as it
kept sending. `mcp-proxy` caps that buffer at 10 MiB (`--maxBodySize` /
`maxBodySize`). An oversized `Content-Length` is rejected before any body is
read; a chunked body is cut off as soon as it exceeds the cap. Either way the
answer is `413 Payload Too Large` with a JSON-RPC error body naming the limit,
then the connection closes.

The default is deliberately generous — base64 images, documents and long pasted
text routinely push a single tool call past a megabyte. Raise it if your clients
legitimately send more, or set `0` (CLI) / `false` (library) to disable it,
which restores unbounded buffering and is only safe behind a gateway that
already limits body size. The cap does not apply to the SSE endpoint, whose
`POST /messages` bodies are read by the MCP SDK rather than by `mcp-proxy`.

#### `startStdioServer`

Starts a proxy that listens on a `stdio`, and sends messages to the attached `sse` or `streamable` server.

```ts
import { ServerType, startStdioServer } from "mcp-proxy";

await startStdioServer({
  serverType: ServerType.SSE,
  url: "http://127.0.0.1:8080/sse",
});
```

Options:

- `serverType`: `ServerType.SSE` or `ServerType.HTTPStream`
- `url`: URL of the upstream MCP server
- `transportOptions`: Options passed to the client transport (optional)
- `upstreamProtocol`: Which protocol revision to speak upstream — `"legacy"` (default, the 2025 `initialize` handshake), `"auto"` (probe with `server/discover`, fall back to the handshake), or `"modern"` (require 2026-07-28). See [Protocol revisions](#protocol-revisions). Note that the stdio connection this serves is 2025-era regardless.
- `initStdioServer` / `initStreamClient`: Bring your own `Server` / `Client` instance (optional)

#### `tapTransport`

Taps into a transport and logs events.

```ts
import { tapTransport } from "mcp-proxy";

const transport = tapTransport(new StdioClientTransport(), (event) => {
  console.log(event);
});
```

## Development

### Running MCP Proxy with a local server

```bash
tsx src/bin/mcp-proxy.ts --debug -- tsx src/fixtures/simple-stdio-server.ts
```
