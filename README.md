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

This starts a server and `stdio` server (`tsx server.js`). The server listens on port 8080 and `/stream` (streamable HTTP) and `/sse` (SSE) endpoints, and forwards messages to the `stdio` server.

options:

- `--server`: Set to `sse` or `stream` to only enable the respective transport (default: both)
- `--endpoint`: If `server` is set to `sse` or `stream`, this option sets the endpoint path (default: `/sse` or `/stream`)
- `--sseEndpoint`: Set the SSE endpoint path (default: `/sse`). Overrides `--endpoint` if `server` is set to `sse`.
- `--streamEndpoint`: Set the streamable HTTP endpoint path (default: `/stream`). Overrides `--endpoint` if `server` is set to `stream`.
- `--port`: Specify the port to listen on (default: 8080)
- `--debug`: Enable debug logging
- `--shell`: Spawn the server via the user's shell

> [!NOTE]
> Any arguments starting with `-` after `<command>` are parsed as `mcp-proxy`
> options. Insert `--` before such arguments to pass them to the wrapped
> command. For example:
>
> ```bash
> npx mcp-proxy --port 8080 --shell npx -- -y some-package
> ```

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
});

close();
```

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
