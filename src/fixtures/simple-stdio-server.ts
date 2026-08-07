import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  {
    name: "example-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: { subscribe: true },
    },
  },
);

server.setRequestHandler("resources/list", async () => {
  return {
    resources: [
      {
        name: "Example Resource",
        uri: "file:///example.txt",
      },
    ],
  };
});

server.setRequestHandler("resources/read", async (request) => {
  if (request.params.uri === "file:///example.txt") {
    return {
      contents: [
        {
          mimeType: "text/plain",
          text: "This is the content of the example resource.",
          uri: "file:///example.txt",
        },
      ],
    };
  } else {
    throw new Error("Resource not found");
  }
});

server.setRequestHandler("resources/templates/list", async () => {
  return {
    resourceTemplates: [
      {
        description: "Specify the filename to retrieve",
        name: "Example resource template",
        uriTemplate: `file://{filename}`,
      },
    ],
  };
});

server.setRequestHandler("resources/subscribe", async () => {
  return {};
});

server.setRequestHandler("resources/unsubscribe", async () => {
  return {};
});

const transport = new StdioServerTransport();

await server.connect(transport);
