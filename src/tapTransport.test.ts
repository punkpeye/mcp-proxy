import {
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";

import { tapTransport } from "./tapTransport.js";

it("preserves per-request headers on a tapped HTTP transport", async () => {
  let statusCode = 200;
  let receivedHeader: string | string[] | undefined;
  const httpServer = createServer((request, response) => {
    receivedHeader = request.headers["mcp-param-tenant"];
    request.resume();
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }));
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  const events: unknown[] = [];
  const transport = tapTransport(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    ),
    (event) => events.push(event),
  );
  const message = { id: 1, jsonrpc: "2.0" as const, method: "ping" };

  try {
    await transport.start();
    await transport.send(message, {
      headers: { "Mcp-Param-Tenant": "tenant-a" },
    });

    expect(receivedHeader).toBe("tenant-a");
    expect(events).toContainEqual({ message, type: "send" });
    expect(JSON.stringify(events)).not.toContain("tenant-a");

    statusCode = 500;
    await expect(transport.send(message)).rejects.toThrow();
  } finally {
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it("preserves received authentication metadata without adding it to tap events", async () => {
  const [sender, receiver] = InMemoryTransport.createLinkedPair();
  const authInfo = {
    clientId: "test-client",
    scopes: ["read"],
    token: "fixture-only",
  };
  let receivedAuthInfo: unknown;
  receiver.onmessage = (_message, extra) => {
    receivedAuthInfo = extra?.authInfo;
  };
  const events: unknown[] = [];
  tapTransport(receiver, (event) => events.push(event));
  const message = { jsonrpc: "2.0" as const, method: "notifications/test" };

  try {
    await sender.start();
    await receiver.start();
    await sender.send(message, { authInfo });

    expect(receivedAuthInfo).toBe(authInfo);
    expect(events).toContainEqual({ message, type: "onmessage" });
    expect(JSON.stringify(events)).not.toContain("fixture-only");
  } finally {
    await sender.close();
    await receiver.close();
  }
});
