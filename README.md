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
  The upstream connection declares one set of client capabilities and one
  identity for all callers, and a 2025-era server's request for input carries
  nothing identifying which caller it belongs to. Guessing means showing one
  user's prompt to another, so the proxy does not guess.
- **`logging/setLevel`** is answered locally and not forwarded, for the same
  reason: the shared upstream carries one level, so forwarding would let one
  client raise or silence another's logs.
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

MCP Proxy supports two invocation patterns:

**Simple usage (no mcp-proxy options):**

```bash
npx mcp-proxy npx -y @anthropic/mcp-server-filesystem /path
```

**With mcp-proxy options:**

```bash
npx mcp-proxy --port 8080 --shell -- tsx server.js
```

This starts a server and `stdio` server (`tsx server.js`). The server listens on port 8080 and `/mcp` (streamable HTTP) and `/sse` (SSE) endpoints, and forwards messages to the `stdio` server.

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
- `--stateless`: Enable stateless mode for HTTP streamable transport (no session management). In this mode, each request creates a new server instance instead of maintaining persistent sessions. Applies to the 2025-era leg; protocol revision 2026-07-28 is per-request by construction.
- `--modern`: Serve protocol revision 2026-07-28 on the streamable HTTP endpoint alongside the 2025-era revisions (default: `true`). Use `--no-modern` to serve only 2025-era clients. See [Protocol revisions](#protocol-revisions).
- `--upstreamProtocol`: Which protocol revision to speak to the spawned server — `legacy` (default), `auto`, or `modern`. See [Protocol revisions](#protocol-revisions).
- `--port`: Specify the port to listen on (default: 8080)
- `--connectionTimeout`: Timeout in milliseconds for the initial connection to the MCP server (default: 60000, which is 60 seconds)
- `--requestTimeout`: Timeout in milliseconds for requests to the MCP server (default: 300000, which is 5 minutes)
- `--keepAliveTimeout`: HTTP keep-alive timeout in milliseconds for stateful stream sessions (default: 300000, which is 5 minutes)
- `--eventStore`: Enable the streamable HTTP transport's resumability event store, which lets clients replay missed messages after a reconnect (default: `true`). Use `--no-eventStore` to disable it entirely for request/response-only deployments that don't need replay and would rather avoid the memory overhead. See [Resumability and memory use](#resumability-and-memory-use).
- `--eventStoreMaxEvents`: Maximum number of buffered events the resumability event store retains per session before it evicts the oldest (default: 1000). Ignored when `--no-eventStore` is set.
- `--maxBodySize`: Maximum request body size in bytes accepted by the streamable HTTP endpoint; larger requests are answered with `413 Payload Too Large` (default: 10485760, which is 10 MiB). Set to `0` to disable the limit. See [Request body size](#request-body-size).
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

If a Python stdio MCP server times out with an error such as `Expected server to respond to ping`, make sure Python is running in unbuffered mode. Buffered stdout can delay MCP JSON-RPC messages long enough for the proxy to treat the server as unresponsive.

Use `python -u` when launching the server:

```bash
npx mcp-proxy -- python -u -m your_package.mcp_server
```

Alternatively, set `PYTHONUNBUFFERED=1`:

```bash
PYTHONUNBUFFERED=1 npx mcp-proxy -- python -m your_package.mcp_server
```

MCP stdio servers should also reserve stdout for protocol messages. Send logs, warnings, and other diagnostic output to stderr, and use `--debug` when you need proxy-side logs.

### Public Tunnel

MCP Proxy can expose your local server to the public internet using a tunnel service. This is useful for testing webhooks, sharing your development server, or accessing your MCP server from anywhere.

```bash
# Expose your MCP server via a public tunnel
npx mcp-proxy --port 8080 --tunnel -- tsx server.js

# Request a specific subdomain
npx mcp-proxy --port 8080 --tunnel --tunnelSubdomain myapp -- tsx server.js
```

When the tunnel is established, you'll see a message like:

```
tunnel established at https://abcdefghij.tunnel.gla.ma
```

> [!NOTE]
> The requested subdomain may not be available. The actual URL will be displayed when the tunnel is established.

This feature is powered by [pipenet](https://github.com/punkpeye/pipenet) and sponsored by [glama.ai](https://glama.ai). For more information, see the [pipenet announcement](https://glama.ai/blog/2026-01-19-pipenet).

### Stateless Mode

By default, MCP Proxy maintains persistent sessions for HTTP streamable transport, where each client connection is associated with a server instance that stays alive for the duration of the session.

Stateless mode (`--stateless`) changes this behavior:

- **No session management**: Each request creates a new server instance instead of maintaining persistent sessions
- **Simplified deployment**: Useful for serverless environments or when you want to minimize memory usage
- **Request isolation**: Each request is completely independent, which can be beneficial for certain use cases

Example usage:

```bash
# Enable stateless mode
npx mcp-proxy --port 8080 --stateless -- tsx server.js

# Stateless mode with stream-only transport
npx mcp-proxy --port 8080 --stateless --server stream -- tsx server.js
```

> [!NOTE]
> Stateless mode only affects HTTP streamable transport (`/mcp` endpoint). SSE transport behavior remains unchanged.

**When to use stateless mode:**

- **Serverless environments**: When deploying to platforms like AWS Lambda, Vercel, or similar
- **Load balancing**: When requests need to be distributed across multiple instances
- **Memory optimization**: When you want to minimize server memory usage
- **Request isolation**: When you need complete independence between requests
- **Simple deployments**: When you don't need to maintain connection state

### API Key Authentication

MCP Proxy supports optional API key authentication to secure your endpoints. When enabled, clients must provide a valid API key in the `X-API-Key` header to access the proxy.

#### Enabling Authentication

Authentication is disabled by default for backward compatibility. To enable it, provide an API key via:

**Command-line:**

```bash
npx mcp-proxy --port 8080 --apiKey "your-secret-key" -- tsx server.js
```

**Environment variable:**

```bash
export MCP_PROXY_API_KEY="your-secret-key"
npx mcp-proxy --port 8080 -- tsx server.js
```

#### Client Configuration

Clients must include the API key in the `X-API-Key` header:

```typescript
// For streamable HTTP transport
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8080/mcp"),
  {
    headers: {
      "X-API-Key": "your-secret-key",
    },
  },
);

// For SSE transport
const transport = new SSEClientTransport(new URL("http://localhost:8080/sse"), {
  headers: {
    "X-API-Key": "your-secret-key",
  },
});
```

#### Exempt Endpoints

The following endpoints do not require authentication:

- `/ping` - Health check endpoint
- `OPTIONS` requests - CORS preflight requests

#### Security Notes

- **Use HTTPS in production**: API keys should only be transmitted over secure connections
- **Keep keys secure**: Never commit API keys to version control
- **Generate strong keys**: Use cryptographically secure random strings for API keys
- **Rotate keys regularly**: Change API keys periodically for better security

### CORS Configuration

MCP Proxy provides flexible CORS (Cross-Origin Resource Sharing) configuration to control how browsers can access your MCP server from different origins.

#### Default Behavior

By default, CORS is enabled with the following settings:

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

#### Basic Configuration

```typescript
import { startHTTPServer } from "mcp-proxy";

// Use default CORS settings (backward compatible)
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
});

// Explicitly enable default CORS
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: true,
});

// Disable CORS completely
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: false,
});
```

#### Advanced CORS Configuration

For more control over CORS behavior, you can provide a detailed configuration:

```typescript
import { startHTTPServer, CorsOptions } from "mcp-proxy";

const corsOptions: CorsOptions = {
  // Allow specific origins
  origin: ["https://app.example.com", "https://admin.example.com"],

  // Or use a function for dynamic origin validation
  origin: (origin: string) => origin.endsWith(".example.com"),

  // Specify allowed methods
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],

  // Allow any headers (useful for browser clients with custom headers)
  allowedHeaders: "*",

  // Or specify exact headers. Replacing the defaults means restating the
  // protocol's own headers - dropping Mcp-Method/Mcp-Name breaks browser
  // clients on protocol revision 2026-07-28.
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Mcp-Session-Id",
    "Mcp-Protocol-Version",
    "Last-Event-Id",
    "Mcp-Method",
    "Mcp-Name",
    "X-Custom-Header",
    "X-API-Key",
  ],

  // Headers to expose to the client
  exposedHeaders: ["Mcp-Session-Id", "X-Total-Count"],

  // Allow credentials
  credentials: true,

  // Cache preflight requests for 24 hours
  maxAge: 86400,
};

await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: corsOptions,
});
```

#### Common Use Cases

**Allow any custom headers (solves browser CORS issues):**

```typescript
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: {
    allowedHeaders: "*", // Allows X-Custom-Header, X-API-Key, etc.
  },
});
```

**Restrict to specific domains:**

```typescript
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: {
    origin: ["https://myapp.com", "https://admin.myapp.com"],
    allowedHeaders: "*",
  },
});
```

**Development-friendly settings:**

```typescript
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5173"], // Common dev ports
    allowedHeaders: "*",
    credentials: true,
  },
});
```

#### CLI: adding allowed headers

The CLI exposes a single `--corsAddAllowedHeader` flag that appends to the
default `Access-Control-Allow-Headers` list (defaults preserved). The most
common use is unblocking the browser preflight for a custom auth header when
the proxy is started with `--apiKey`:

```bash
npx mcp-proxy --port 8080 --apiKey secret \
  --corsAddAllowedHeader X-API-Key \
  -- npx -y @modelcontextprotocol/server-filesystem /srv
```

Repeat the flag to add more (`--corsAddAllowedHeader X-API-Key --corsAddAllowedHeader X-Other`).
For broader CORS overrides (origin allowlist, wildcard headers, disabling CORS),
use the programmatic `cors` option below.

#### Migration from Older Versions

If you were using mcp-proxy 5.5.6 and want the same permissive behavior in 5.9.0+:

```typescript
// Old behavior (5.5.6) - automatic wildcard headers
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
});

// New equivalent (5.9.0+) - explicit wildcard headers
await startHTTPServer({
  createServer: async () => {
    /* ... */
  },
  port: 3000,
  cors: {
    allowedHeaders: "*",
  },
});
```

### Node.js SDK

The Node.js SDK provides several utilities that are used to create a proxy.

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
> single upstream client, so upstream notifications reach **every** connected
> client. If you derive per-request identity in `createServer` to serve several
> tenants from one proxy, note that `notifications/message` and
> `notifications/resources/updated` are not partitioned by tenant.

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
- `maxBodySize`: Caps how many bytes of a request body the streamable HTTP endpoint buffers; larger requests are answered with `413 Payload Too Large` (default: 10485760, which is 10 MiB). Pass `false` to disable the cap. See [Request body size](#request-body-size).
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
`addResourceSubscription` / `removeResourceSubscription` / `release`; resource
subscriptions are owned per lease, so one connection unsubscribing never
cancels a URI another connection still wants, and `release()` drops whatever a
disconnecting connection still held.

A 2026-07-28 client asks for resource updates through the `resourceSubscriptions`
field of its `subscriptions/listen` filter rather than `resources/subscribe`,
which the serving entry answers itself. Pass `onListenSubscriptions` to act on
those URIs — the CLI wires it to the same bridge:

```ts
await startHTTPServer({
  createServer,
  onListenSubscriptions: async (uris) => {
    const lease = getUpstreamBridge({ client }).subscribe({});

    await Promise.all(uris.map((uri) => lease.addResourceSubscription(uri)));

    return () => lease.release();
  },
  port: 8080,
});
```

##### Resumability and memory use

The streamable HTTP transport can retain server→client messages so a client
that reconnects with a `Last-Event-ID` can resume where it left off. By
default, `mcp-proxy` gives each session its own `InMemoryEventStore` capped at
1000 buffered events (oldest evicted first via `--eventStoreMaxEvents` /
`eventStoreMaxEvents`), so a long-lived session's memory use stays bounded
instead of growing for as long as the process runs.

If you don't need resume-after-reconnect - for example, a short-lived
request/response deployment - disable the store entirely with
`--no-eventStore` (CLI) or `eventStore: false` (library) to drop the
resumability bookkeeping altogether.

If you need resumability with a larger replay window or one backed by shared
storage (e.g. Redis) across multiple proxy processes, pass your own
`EventStore` implementation as `eventStore`; in that case you're responsible
for bounding its size.

##### Request body size

The streamable HTTP endpoint buffers each request body in memory before it
parses the JSON-RPC message, so a single slow-chunking client could otherwise
grow the process's memory for as long as it kept sending. `mcp-proxy` caps
that buffer at 10 MiB by default (`--maxBodySize` / `maxBodySize`).

A request over the cap is answered with `413 Payload Too Large` and a JSON-RPC
error body naming the limit, then the connection is closed; the server also
logs `[mcp-proxy] request body too large`. When the client declares an
oversized `Content-Length`, it is rejected before any of the body is read; a
chunked body that declares no size up front is cut off as soon as the bytes
received exceed the cap.

The default is deliberately generous, because MCP payloads are often large -
base64-encoded images, documents and long pasted text routinely push a single
tool call past a megabyte. Raise it if your clients legitimately send more, or
set it to `0` (CLI) / `false` (library) to disable the cap entirely, which
restores unbounded buffering and is only safe behind a gateway that already
limits body size.

The cap applies to the streamable HTTP endpoint only. The SSE endpoint's
`POST /messages` bodies are read by the MCP SDK, not by `mcp-proxy`, so this
option does not affect them.

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
