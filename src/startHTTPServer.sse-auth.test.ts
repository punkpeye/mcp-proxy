import { Client, SSEClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import http from "node:http";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { startHTTPServer } from "./startHTTPServer.js";

type Auth = { role: "admin" | "user" };

// The only credentials `authenticate` accepts. Anything else - no header, or a
// token that has since been revoked - fails authentication.
const roles = new Map<string, Auth>([
  ["Bearer admin-token", { role: "admin" }],
  ["Bearer user-token", { role: "user" }],
]);

const authenticate = async (request: http.IncomingMessage) =>
  roles.get(request.headers.authorization ?? "");

const invalidCredentials: Array<Record<string, string>> = [
  {},
  { Authorization: "Bearer revoked-token" },
];

/**
 * A server that, like a FastMCP session, lets a caller see the secret only
 * while its auth context is an admin's. It starts from whatever auth
 * `createServer` gives it and afterwards follows `updateAuth`.
 */
const createRoleServer = (initialAuth?: Auth) => {
  let auth = initialAuth;

  const toolCalls: Array<Auth | undefined> = [];

  const server = new Server(
    { name: "test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [{ inputSchema: { type: "object" as const }, name: "secret" }],
  }));

  server.setRequestHandler("tools/call", async () => {
    toolCalls.push(auth);

    return {
      content: [
        {
          text: auth?.role === "admin" ? "secret" : "forbidden",
          type: "text" as const,
        },
      ],
    };
  });

  return Object.assign(server, {
    toolCalls,
    updateAuth: vi.fn((next: Auth) => {
      auth = next;
    }),
  });
};

const callSecret = (id: number) =>
  JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "secret" },
  });

type JsonRpcMessage = { id?: unknown };

/**
 * Opens a legacy SSE stream the way a 2024-11-05 client does, and collects the
 * messages the server sends down it.
 */
const openStream = async (
  port: number,
  headers: http.OutgoingHttpHeaders = {},
) => {
  const messages: JsonRpcMessage[] = [];

  let endpoint: string | undefined;
  let buffer = "";

  const request = http.get({ headers, host: "localhost", path: "/sse", port });

  request.on("error", () => {});

  request.on("response", (response) => {
    response.setEncoding("utf8");

    response.on("data", (chunk: string) => {
      buffer += chunk;

      let end = buffer.indexOf("\n\n");

      while (end !== -1) {
        const event = buffer.slice(0, end);
        const data = /^data: (.*)$/m.exec(event)?.[1] ?? "";

        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");

        if (event.startsWith("event: endpoint")) {
          endpoint = data;
        } else if (event.startsWith("event: message")) {
          messages.push(JSON.parse(data) as JsonRpcMessage);
        }
      }
    });
  });

  // Where the server tells the client to POST, `sessionId` included.
  const messagesPath = await vi.waitFor(() => {
    expect(endpoint).toBeDefined();

    return endpoint!;
  });

  return {
    close: () => {
      request.destroy();
    },
    endpoint: messagesPath,
    messages,
    /** Resolves with the server's response to the request with this id. */
    responseTo: (id: number) =>
      vi.waitFor(() => {
        const response = messages.find((message) => message.id === id);

        expect(response).toBeDefined();

        return response;
      }),
  };
};

const post = (
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  fetch(`http://localhost:${port}${path}`, {
    body,
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });

/**
 * Writes a raw HTTP request and returns everything the server wrote back. The
 * 413 path tears the connection down, which `fetch` would report as a network
 * error rather than a status line.
 */
const sendRaw = (port: number, request: string) =>
  new Promise<string>((resolve) => {
    const received: Buffer[] = [];
    const socket = net.connect(port, "localhost", () => {
      socket.write(request);
    });

    const done = () => {
      resolve(Buffer.concat(received).toString());
    };

    socket.on("data", (chunk) => received.push(chunk));
    socket.on("close", done);
    // ECONNRESET once the server tears the connection down is expected.
    socket.on("error", done);
  });

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }

  vi.restoreAllMocks();
});

it("answers a legacy SSE message without valid credentials with 401, before the server sees it", async () => {
  const port = await getRandomPort();
  const server = createRoleServer();

  const httpServer = await startHTTPServer({
    authenticate,
    createServer: async () => server,
    port,
  });

  cleanups.push(() => httpServer.close());

  // Opened by an admin. All a later POST shares with it is the session id.
  const stream = await openStream(port, {
    Authorization: "Bearer admin-token",
  });

  cleanups.push(stream.close);

  for (const headers of invalidCredentials) {
    const response = await post(port, stream.endpoint, callSecret(1), headers);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer .*error="invalid_token"/,
    );
    expect(await response.json()).toMatchObject({
      error: { code: -32000 },
      id: 1,
    });
  }

  // A session's messages are dispatched in arrival order, so once a later one
  // has been answered, a rejected one that slipped through would have run.
  const ping = await post(
    port,
    stream.endpoint,
    JSON.stringify({ id: 2, jsonrpc: "2.0", method: "ping" }),
    { Authorization: "Bearer admin-token" },
  );

  expect(ping.status).toBe(202);

  await ping.text();
  await stream.responseTo(2);

  expect(server.toolCalls).toEqual([]);
  expect(stream.messages.some((message) => message.id === 1)).toBe(false);
  // Only the ping's auth result reached the server.
  expect(server.updateAuth.mock.calls).toEqual([[{ role: "admin" }]]);
});

it("hands each legacy SSE message's own auth result to the server before it is handled", async () => {
  const port = await getRandomPort();
  const servers: Array<ReturnType<typeof createRoleServer>> = [];

  const httpServer = await startHTTPServer({
    authenticate,
    // Takes its starting auth from whoever opened the stream, as FastMCP does.
    createServer: async (request) => {
      const server = createRoleServer(await authenticate(request));

      servers.push(server);

      return server;
    },
    port,
  });

  cleanups.push(() => httpServer.close());

  const stream = await openStream(port, {
    Authorization: "Bearer admin-token",
  });

  cleanups.push(stream.close);

  const asAdmin = await post(port, stream.endpoint, callSecret(1), {
    Authorization: "Bearer admin-token",
  });

  expect(asAdmin.status).toBe(202);

  await asAdmin.text();

  expect(await stream.responseTo(1)).toMatchObject({
    result: { content: [{ text: "secret" }] },
  });

  // The same session, after its caller's admin token was swapped for a lesser
  // one. It must be served as what it is now, not as whoever opened the stream.
  const asUser = await post(port, stream.endpoint, callSecret(2), {
    Authorization: "Bearer user-token",
  });

  expect(asUser.status).toBe(202);

  await asUser.text();

  expect(await stream.responseTo(2)).toMatchObject({
    result: { content: [{ text: "forbidden" }] },
  });

  expect(servers).toHaveLength(1);
  expect(servers[0].updateAuth.mock.calls).toEqual([
    [{ role: "admin" }],
    [{ role: "user" }],
  ]);
});

it("refuses to open a legacy SSE stream that authenticate rejects, even when createServer checks nothing", async () => {
  const port = await getRandomPort();
  const createServer = vi.fn(async () => createRoleServer());

  const httpServer = await startHTTPServer({
    authenticate,
    createServer,
    port,
  });

  cleanups.push(() => httpServer.close());

  for (const headers of invalidCredentials) {
    const response = await fetch(`http://localhost:${port}/sse`, { headers });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer .*error="invalid_token"/,
    );
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
  }

  expect(createServer).not.toHaveBeenCalled();
});

it("answers an oversized legacy SSE message with 413", async () => {
  const port = await getRandomPort();
  const server = createRoleServer();

  vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => server,
    maxBodySize: 1_024,
    port,
  });

  cleanups.push(() => httpServer.close());

  const stream = await openStream(port);

  cleanups.push(stream.close);

  const body = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { padding: "x".repeat(4_096) }, name: "secret" },
  });

  const response = await sendRaw(
    port,
    `POST ${stream.endpoint} HTTP/1.1\r\n` +
      `Host: localhost:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      body,
  );

  expect(response).toContain("HTTP/1.1 413");
  expect(response).toContain("Payload Too Large");
  expect(server.toolCalls).toEqual([]);
});

it("answers a legacy SSE message that is not a JSON-RPC object with 400", async () => {
  const port = await getRandomPort();
  const server = createRoleServer();

  vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    createServer: async () => server,
    port,
  });

  cleanups.push(() => httpServer.close());

  const stream = await openStream(port);

  cleanups.push(stream.close);

  // Unparseable, and a message that is valid JSON only once decoded twice. The
  // body has already been read and parsed by the time the SDK sees it, so it
  // must neither fall back to reading it again nor decode it a second time.
  for (const body of ["{not json", JSON.stringify(callSecret(1))]) {
    const response = await post(port, stream.endpoint, body);

    expect(response.status).toBe(400);

    await response.text();
  }

  expect(server.toolCalls).toEqual([]);
});

it("serves legacy SSE without credentials when no authenticate is configured", async () => {
  const port = await getRandomPort();
  const server = createRoleServer();

  const httpServer = await startHTTPServer({
    createServer: async () => server,
    port,
  });

  cleanups.push(() => httpServer.close());

  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(
    new SSEClientTransport(new URL(`http://localhost:${port}/sse`)),
  );

  cleanups.push(() => client.close());

  expect(
    await client.callTool({ arguments: {}, name: "secret" }),
  ).toMatchObject({ content: [{ text: "forbidden" }] });

  expect(server.toolCalls).toEqual([undefined]);
  expect(server.updateAuth).not.toHaveBeenCalled();
});
