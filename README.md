# MCP Proxy

A TypeScript streamable HTTP and SSE proxy for [MCP](https://modelcontextprotocol.io/) servers that use `stdio` transport.

> [!NOTE]
> CORS is enabled by default.

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

```bash
npx mcp-proxy --port 8080 --shell tsx server.js
```

This starts a server and `stdio` server (`tsx server.js`). The server listens on port 8080 and `/mcp` (streamable HTTP) and `/sse` (SSE) endpoints, and forwards messages to the `stdio` server.

options:

- `--server`: Set to `sse` or `stream` to only enable the respective transport (default: both)
- `--endpoint`: If `server` is set to `sse` or `stream`, this option sets the endpoint path (default: `/sse` or `/mcp`)
- `--sseEndpoint`: Set the SSE endpoint path (default: `/sse`). Overrides `--endpoint` if `server` is set to `sse`.
- `--streamEndpoint`: Set the streamable HTTP endpoint path (default: `/mcp`). Overrides `--endpoint` if `server` is set to `stream`.
- `--stateless`: Enable stateless mode for HTTP streamable transport (no session management). In this mode, each request creates a new server instance instead of maintaining persistent sessions.
- `--port`: Specify the port to listen on (default: 8080)
- `--requestTimeout`: Timeout in milliseconds for requests to the MCP server (default: 300000, which is 5 minutes)
- `--debug`: Enable debug logging
- `--shell`: Spawn the server via the user's shell
- `--apiKey`: API key for authenticating requests (uses X-API-Key header)

### Passing arguments to the wrapped command

When wrapping a command that takes arguments starting with `-`, you must use `--` to prevent `mcp-proxy` from interpreting them as its own options. Everything after `--` is passed directly to the wrapped command.

For example, to wrap a command that uses the `-v` flag:

```bash
# Wrong: mcp-proxy will try to parse -v as its own option
npx mcp-proxy --port 8080 my-command -v

# Correct: use -- to pass -v to my-command
npx mcp-proxy --port 8080 -- my-command -v
```

### Stateless Mode

By default, MCP Proxy maintains persistent sessions for HTTP streamable transport, where each client connection is associated with a server instance that stays alive for the duration of the session. 

Stateless mode (`--stateless`) changes this behavior:

- **No session management**: Each request creates a new server instance instead of maintaining persistent sessions
- **Simplified deployment**: Useful for serverless environments or when you want to minimize memory usage
- **Request isolation**: Each request is completely independent, which can be beneficial for certain use cases

Example usage:

```bash
# Enable stateless mode
npx mcp-proxy --port 8080 --stateless tsx server.js

# Stateless mode with stream-only transport
npx mcp-proxy --port 8080 --stateless --server stream tsx server.js
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
npx mcp-proxy --port 8080 --apiKey "your-secret-key" tsx server.js
```

**Environment variable:**
```bash
export MCP_PROXY_API_KEY="your-secret-key"
npx mcp-proxy --port 8080 tsx server.js
```

#### Client Configuration

Clients must include the API key in the `X-API-Key` header:

```typescript
// For streamable HTTP transport
const transport = new StreamableHTTPClientTransport(
  new URL('http://localhost:8080/mcp'),
  {
    headers: {
      'X-API-Key': 'your-secret-key'
    }
  }
);

// For SSE transport
const transport = new SSEClientTransport(
  new URL('http://localhost:8080/sse'),
  {
    headers: {
      'X-API-Key': 'your-secret-key'
    }
  }
);
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
tsx src/bin/mcp-proxy.ts --debug tsx src/fixtures/simple-stdio-server.ts
```
