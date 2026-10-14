import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// An upstream that dies mid-session: calling `disconnect` exits the process,
// the way a crashed or killed stdio MCP server would.
const server = new Server(
  {
    name: "exiting-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      description: "Exits the server process",
      inputSchema: { properties: {}, type: "object" as const },
      name: "disconnect",
    },
  ],
}));

server.setRequestHandler("tools/call", async () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
