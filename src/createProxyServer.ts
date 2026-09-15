import { Client } from "@modelcontextprotocol/client";
import { Server, ServerCapabilities } from "@modelcontextprotocol/server";

export const createProxyServer = (client: Client) => {
  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };
  const serverCapabilities = client.getServerCapabilities() as ServerCapabilities;

  return {
    server: new Server(serverVersion, {
      capabilities: serverCapabilities,
      instructions: client.getInstructions(),
    }),
    serverCapabilities,
  };
};
