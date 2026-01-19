# MCP Proxy

A TypeScript streamable HTTP and SSE proxy for [MCP](https://modelcontextprotocol.io/) servers that use `stdio` transport.

> [!NOTE]
> CORS is enabled by default with configurable options. See [CORS Configuration](#cors-configuration) for details.

> [!NOTE]
> For a Python implementation, see [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

> [!NOTE]
> MCP Proxy is what [FastMCP](https://github.com/punkpeye/fastmcp) uses to enable streamable HTTP and SSE.

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
- `--stateless`: Enable stateless mode for HTTP streamable transport (no session management). In this mode, each request creates a new server instance instead of maintaining persistent sessions.
- `--port`: Specify the port to listen on (default: 8080)
- `--connectionTimeout`: Timeout in milliseconds for the initial connection to the MCP server (default: 60000, which is 60 seconds)
- `--requestTimeout`: Timeout in milliseconds for requests to the MCP server (default: 300000, which is 5 minutes)
- `--debug`: Enable debug logging
- `--shell`: Spawn the server via the user's shell
- `--apiKey`: API key for authenticating requests (uses X-API-Key header)
- `--sslCa`: Filename to override the trusted CA certificates
- `--sslCert`: Cert chains filename in PEM format
- `--sslKey`: Private keys filename in PEM format
- `--tunnel`: Expose the proxy via a public tunnel (see [Public Tunnel](#public-tunnel))
- `--tunnelSubdomain`: Request a specific subdomain for the tunnel (availability not guaranteed)

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

This feature is powered by [pipenet](https://github.com/AugmentHQ/pipenet) and sponsored by [glama.ai](https://glama.ai). For more information, see the [pipenet announcement](https://glama.ai/blog/2026-01-19-pipenet).

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
- **Headers**: `Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id`
- **Credentials**: `true`
- **Exposed Headers**: `Mcp-Session-Id`

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

  // Or specify exact headers
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Mcp-Session-Id",
    "Last-Event-Id",
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

const server = new Server(serverVersion, {
  capabilities: {},
});

proxyServer({
  server,
  client,
  capabilities: {},
});
```

In this example, the server will proxy all requests to the client and vice versa.

#### `startHTTPServer`

Starts a proxy that listens on a `port`, and sends messages to the attached server via `StreamableHTTPServerTransport` and `SSEServerTransport`.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startHTTPServer } from "mcp-proxy";

const { close } = await startHTTPServer({
  createServer: async () => {
    return new Server();
  },
  eventStore: new InMemoryEventStore(),
  port: 8080,
  stateless: false, // Optional: enable stateless mode for streamable HTTP transport
});

close();
```

Options:

- `createServer`: Function that creates a new server instance for each connection
- `eventStore`: Event store for streamable HTTP transport (optional)
- `port`: Port number to listen on
- `host`: Host to bind to (default: "::")
- `sseEndpoint`: SSE endpoint path (default: "/sse", set to null to disable)
- `streamEndpoint`: Streamable HTTP endpoint path (default: "/mcp", set to null to disable)
- `stateless`: Enable stateless mode for HTTP streamable transport (default: false)
- `apiKey`: API key for authenticating requests (optional)
- `cors`: CORS configuration (default: enabled with permissive settings, see CORS Configuration section)
- `onConnect`: Callback when a server connects (optional)
- `onClose`: Callback when a server disconnects (optional)
- `onUnhandledRequest`: Callback for unhandled HTTP requests (optional)

#### `startStdioServer`

Starts a proxy that listens on a `stdio`, and sends messages to the attached `sse` or `streamable` server.

```ts
import { ServerType, startStdioServer } from "./startStdioServer.js";

await startStdioServer({
  serverType: ServerType.SSE,
  url: "http://127.0.0.1:8080/sse",
});
```

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
