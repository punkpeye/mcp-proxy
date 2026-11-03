import {
  Client,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";

import {
  type BeforeDispatchHandler,
  startHTTPServer,
} from "./startHTTPServer.js";

type Auth = { scopes: string[] };

// The scopes each token was granted.
const tokens = new Map<string, Auth>([
  ["Bearer read-token", { scopes: ["files:read"] }],
  ["Bearer write-token", { scopes: ["files:read", "files:write"] }],
]);

const authenticate = async (request: http.IncomingMessage) =>
  tokens.get(request.headers.authorization ?? "");

// The scopes each tool needs - something only the server knows.
const toolScopes: Record<string, string[]> = {
  read: ["files:read"],
  write: ["files:read", "files:write"],
};

const oauth = {
  protectedResource: { resource: "https://files.example.com/mcp" },
};

const RESOURCE_METADATA_URL =
  "https://files.example.com/.well-known/oauth-protected-resource/mcp";

/** What a server throws for mcp-proxy to answer with the scope challenge. */
const insufficientScope = (requiredScopes: string[]) =>
  Object.assign(new Error("Insufficient scope"), {
    data: {
      error: "insufficient_scope",
      errorDescription: "This tool needs more scopes",
      requiredScopes,
    },
    name: "InsufficientScopeError",
  });

/**
 * The check a server would make: everything goes through except a `tools/call`
 * whose token lacks the tool's scopes.
 */
const challengeScopes: BeforeDispatchHandler<unknown> = ({
  authResult,
  message,
}) => {
  const call = message as { method?: unknown; params?: { name?: unknown } };

  if (call.method !== "tools/call") {
    return undefined;
  }

  const required = toolScopes[String(call.params?.name)] ?? [];
  const granted = (authResult as Auth | undefined)?.scopes ?? [];

  if (required.every((scope) => granted.includes(scope))) {
    return undefined;
  }

  throw insufficientScope(required);
};

const createFileServer = (toolCalls: string[]) => {
  const server = new Server(
    { name: "files", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: Object.keys(toolScopes).map((name) => ({
      inputSchema: { type: "object" as const },
      name,
    })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    toolCalls.push(request.params.name);

    return {
      content: [{ text: `${request.params.name} done`, type: "text" as const }],
    };
  });

  return server;
};

const callTool = (id: number, name: string) => ({
  id,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: {}, name },
});

const STREAM_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const postStream = (
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    body: JSON.stringify(body),
    headers: { ...STREAM_HEADERS, ...headers },
    method: "POST",
  });

const initializeMessage = {
  id: 0,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "raw-client", version: "1.0.0" },
    protocolVersion: "2025-11-25",
  },
};

/**
 * Opens a 2025-era session by hand, for the tests that look at the wire, and
 * returns a function that POSTs to it.
 */
const openSession = async (port: number, token?: string) => {
  const credentials: Record<string, string> = token
    ? { Authorization: token }
    : {};

  const initialize = await postStream(port, initializeMessage, credentials);

  expect(initialize.status).toBe(200);

  await initialize.text();

  const sessionId = initialize.headers.get("mcp-session-id");

  expect(sessionId).toBeTruthy();

  return (body: unknown) =>
    postStream(port, body, {
      ...credentials,
      "Mcp-Protocol-Version": "2025-11-25",
      "Mcp-Session-Id": sessionId!,
    });
};

const connectClient = async (
  port: number,
  era: "legacy" | "modern",
  token: string,
) => {
  const client = new Client(
    { name: `${era}-client`, version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation:
        era === "modern" ? { mode: { pin: "2026-07-28" } } : undefined,
    },
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: token } },
    }),
  );

  cleanups.push(() => client.close());

  return client;
};

type JsonRpcMessage = { id?: unknown };

/**
 * Opens a legacy SSE stream the way a 2024-11-05 client does, and collects the
 * messages the server sends down it.
 */
const openSSEStream = async (
  port: number,
  headers: http.OutgoingHttpHeaders,
) => {
  const messages: JsonRpcMessage[] = [];

  let endpoint: string | undefined;
  let buffer = "";

  const request = http.get({ headers, host: "127.0.0.1", path: "/sse", port });

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

  cleanups.push(() => {
    request.destroy();
  });

  const messagesPath = await vi.waitFor(() => {
    expect(endpoint).toBeDefined();

    return endpoint!;
  });

  return {
    messages,
    post: (body: unknown, token: string) =>
      fetch(`http://127.0.0.1:${port}${messagesPath}`, {
        body: JSON.stringify(body),
        headers: { Authorization: token, "Content-Type": "application/json" },
        method: "POST",
      }),
    /** Resolves with the server's response to the request with this id. */
    responseTo: (id: number) =>
      vi.waitFor(() => {
        const response = messages.find((message) => message.id === id);

        expect(response).toBeDefined();

        return response;
      }),
  };
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }

  vi.restoreAllMocks();
});

for (const era of ["legacy", "modern"] as const) {
  it(`challenges a ${era} tools/call the token lacks scopes for, before the tool runs`, async () => {
    const port = await getRandomPort();
    const toolCalls: string[] = [];

    const httpServer = await startHTTPServer({
      authenticate,
      beforeDispatch: challengeScopes,
      createServer: async () => createFileServer(toolCalls),
      oauth,
      port,
    });

    cleanups.push(() => httpServer.close());

    const client = await connectClient(port, era, "Bearer read-token");

    expect(client.getProtocolEra()).toBe(era);

    // The SDK client recognizes the answer as a scope challenge. Given an
    // OAuth provider, it would re-authorize for these scopes and retry.
    const error = await client
      .callTool({ arguments: {}, name: "write" })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(InsufficientScopeError);
    expect(error).toMatchObject({
      errorDescription: "This tool needs more scopes",
      requiredScope: "files:read files:write",
    });
    expect(String((error as InsufficientScopeError).resourceMetadataUrl)).toBe(
      RESOURCE_METADATA_URL,
    );

    expect(
      await client.callTool({ arguments: {}, name: "read" }),
    ).toMatchObject({ content: [{ text: "read done" }] });

    expect(toolCalls).toEqual(["read"]);
  });
}

it("answers with the scope challenge built from oauth, naming the message that needs the scopes", async () => {
  const port = await getRandomPort();
  const toolCalls: string[] = [];
  const beforeDispatch = vi.fn(challengeScopes);

  const httpServer = await startHTTPServer({
    authenticate,
    beforeDispatch,
    createServer: async () => createFileServer(toolCalls),
    oauth,
    port,
  });

  cleanups.push(() => httpServer.close());

  const post = await openSession(port, "Bearer read-token");

  // The call travels in a batch behind a ping. Each message is offered on its
  // own, so it cannot slip past a check written for single messages.
  const response = await post([
    { id: 7, jsonrpc: "2.0", method: "ping" },
    callTool(8, "write"),
  ]);

  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer error="insufficient_scope", scope="files:read files:write", resource_metadata="${RESOURCE_METADATA_URL}", error_description="This tool needs more scopes"`,
  );
  expect(await response.json()).toEqual({
    error: {
      code: -32001,
      data: {
        error: "insufficient_scope",
        required_scopes: ["files:read", "files:write"],
      },
      message: "This tool needs more scopes",
    },
    id: 8,
    jsonrpc: "2.0",
  });

  // `initialize`, then both messages of the batch.
  expect(
    beforeDispatch.mock.calls.map(([{ message }]) => message),
  ).toMatchObject([
    { method: "initialize" },
    { method: "ping" },
    { method: "tools/call" },
  ]);

  // The answer covers the whole request, so not even the ping was dispatched.
  expect(toolCalls).toEqual([]);
});

it("still challenges with the required scopes when oauth is not configured", async () => {
  const port = await getRandomPort();
  const toolCalls: string[] = [];

  const httpServer = await startHTTPServer({
    authenticate,
    beforeDispatch: challengeScopes,
    createServer: async () => createFileServer(toolCalls),
    port,
    stateless: true,
  });

  cleanups.push(() => httpServer.close());

  const response = await postStream(port, callTool(1, "write"), {
    Authorization: "Bearer read-token",
  });

  // All of the challenge but `resource_metadata`, which only oauth can supply.
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer error="insufficient_scope", scope="files:read files:write", error_description="This tool needs more scopes"',
  );
  expect(await response.json()).toMatchObject({ error: { code: -32001 } });

  // Enough for the SDK client to know which scopes to re-authorize for.
  const client = await connectClient(port, "legacy", "Bearer read-token");

  const error = await client
    .callTool({ arguments: {}, name: "write" })
    .catch((error: unknown) => error);

  expect(error).toBeInstanceOf(InsufficientScopeError);
  expect(error).toMatchObject({
    errorDescription: "This tool needs more scopes",
    requiredScope: "files:read files:write",
  });
  expect((error as InsufficientScopeError).resourceMetadataUrl).toBeUndefined();

  expect(toolCalls).toEqual([]);
});

for (const how of ["returned", "thrown"] as const) {
  it(`answers with a Response beforeDispatch has ${how}, verbatim, and hands it the request's context`, async () => {
    const port = await getRandomPort();
    const toolCalls: string[] = [];
    const servers: Server[] = [];

    const beforeDispatch = vi.fn<BeforeDispatchHandler<Server>>(
      ({ message }) => {
        if ((message as { method?: unknown }).method !== "tools/call") {
          return undefined;
        }

        const response = new Response("Come back with more scopes", {
          headers: {
            "WWW-Authenticate": 'Bearer error="insufficient_scope"',
            "X-Reason": "scopes",
          },
          status: 403,
        });

        if (how === "thrown") {
          throw response;
        }

        return response;
      },
    );

    const httpServer = await startHTTPServer({
      authenticate,
      beforeDispatch,
      createServer: async () => {
        const server = createFileServer(toolCalls);

        servers.push(server);

        return server;
      },
      port,
    });

    cleanups.push(() => httpServer.close());

    const post = await openSession(port, "Bearer read-token");

    const response = await post(callTool(1, "read"));

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope"',
    );
    expect(response.headers.get("x-reason")).toBe("scopes");
    expect(await response.text()).toBe("Come back with more scopes");
    expect(toolCalls).toEqual([]);

    const context = beforeDispatch.mock.calls.at(-1)![0];

    expect(context.authResult).toEqual({ scopes: ["files:read"] });
    expect(context.message).toEqual(callTool(1, "read"));
    expect(context.request.headers.authorization).toBe("Bearer read-token");
    // The session's own server, not a new one.
    expect(servers).toHaveLength(1);
    expect(context.server).toBe(servers[0]);
  });
}

it("challenges a legacy SSE message the token lacks scopes for, before the server sees it", async () => {
  const port = await getRandomPort();
  const toolCalls: string[] = [];

  const httpServer = await startHTTPServer({
    authenticate,
    beforeDispatch: challengeScopes,
    createServer: async () => createFileServer(toolCalls),
    oauth,
    port,
  });

  cleanups.push(() => httpServer.close());

  const stream = await openSSEStream(port, {
    Authorization: "Bearer read-token",
  });

  const denied = await stream.post(callTool(1, "write"), "Bearer read-token");

  expect(denied.status).toBe(403);
  expect(denied.headers.get("www-authenticate")).toMatch(
    /^Bearer error="insufficient_scope", scope="files:read files:write"/,
  );
  expect(await denied.json()).toMatchObject({ id: 1 });

  const allowed = await stream.post(callTool(2, "read"), "Bearer read-token");

  expect(allowed.status).toBe(202);

  await allowed.text();

  // Messages are dispatched in arrival order, so once the later one has been
  // answered, the denied one would have been too had it slipped through.
  expect(await stream.responseTo(2)).toMatchObject({
    result: { content: [{ text: "read done" }] },
  });
  expect(stream.messages.some((message) => message.id === 1)).toBe(false);
  expect(toolCalls).toEqual(["read"]);
});

it("releases a server it built for a request that beforeDispatch answers", async () => {
  const port = await getRandomPort();
  const toolCalls: string[] = [];
  const servers: Server[] = [];

  const onClose = vi.fn<(server: Server) => Promise<void>>(async () => {});

  const options = {
    beforeDispatch: () => new Response(null, { status: 403 }),
    createServer: async () => {
      const server = createFileServer(toolCalls);

      servers.push(server);

      return server;
    },
    onClose,
  };

  const httpServer = await startHTTPServer({ ...options, port });

  cleanups.push(() => httpServer.close());

  // Picked only once `port` is bound, so the two cannot collide.
  const statelessPort = await getRandomPort();

  const statelessServer = await startHTTPServer({
    ...options,
    port: statelessPort,
    stateless: true,
  });

  cleanups.push(() => statelessServer.close());

  // An `initialize` that never gets to register its session...
  const initialize = await postStream(port, initializeMessage);

  expect(initialize.status).toBe(403);
  expect(initialize.headers.get("mcp-session-id")).toBeNull();

  // ...a 2026-07-28 request, whose instance exists for that request only...
  const modern = await postStream(
    port,
    {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "raw-client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
        arguments: {},
        name: "read",
      },
    },
    { "Mcp-Method": "tools/call", "Mcp-Name": "read" },
  );

  expect(modern.status).toBe(403);

  // ...and a stateless one, likewise.
  const stateless = await postStream(statelessPort, callTool(1, "read"));

  expect(stateless.status).toBe(403);

  expect(servers).toHaveLength(3);

  await vi.waitFor(() => {
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  const closed = onClose.mock.calls.map(([server]) => server);

  for (const server of servers) {
    expect(closed.includes(server)).toBe(true);
  }

  expect(toolCalls).toEqual([]);
});

it("answers 500 when beforeDispatch fails, without dispatching the message", async () => {
  const port = await getRandomPort();
  const toolCalls: string[] = [];

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const httpServer = await startHTTPServer({
    beforeDispatch: ({ message }) => {
      if ((message as { method?: unknown }).method === "tools/call") {
        throw new Error("scope lookup failed");
      }

      return undefined;
    },
    createServer: async () => createFileServer(toolCalls),
    port,
  });

  cleanups.push(() => httpServer.close());

  const post = await openSession(port);

  const response = await post(callTool(1, "read"));

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: -32603 } });
  expect(toolCalls).toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(
    "[mcp-proxy] error in beforeDispatch",
    expect.objectContaining({ message: "scope lookup failed" }),
  );
});
