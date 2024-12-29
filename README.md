# MCP Proxy

A TypeScript SSE proxy for [MCP](https://modelcontextprotocol.io/) servers that use `stdio` transport.

> [!NOTE]
> For a Python implementation, see [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy).

> [!NOTE]
> MCP Proxy is what [FastMCP](https://github.com/punkpeye/fastmcp) uses to enable SSE.

## Installation

```bash
npm install mcp-proxy
```

## Quickstart

### Command-line

```bash
npx mcp-proxy --port 8080 --endpoint /sse tsx server.js
```

This starts an SSE server and `stdio` server (`tsx server.js`). The SSE server listens on port 8080 and endpoint `/sse`, and forwards messages to the `stdio` server.

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

#### `startSSEServer`

Starts a proxy that listens on a `port` and `endpoint`, and sends messages to the attached server via `SSEServerTransport`.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startSSEServer } from "mcp-proxy";

const server = new Server();

const { close } = await startSSEServer({
  port: 8080,
  endpoint: "/sse",
  server,
});

close();
```

#### `tapTransport`

Taps into a transport and logs events.

```ts
import { tapTransport } from "mcp-proxy";

const transport = tapTransport(new StdioClientTransport(), (event) => {
  console.log(event);
});
```
