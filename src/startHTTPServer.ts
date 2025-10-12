import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  EventStore,
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "node:crypto";

import { AuthConfig, AuthenticationMiddleware } from "./authentication.js";
import { InMemoryEventStore } from "./InMemoryEventStore.js";

export type SSEServer = {
  close: () => Promise<void>;
};

type ServerLike = {
  close: Server["close"];
  connect: Server["connect"];
};

const getBody = (request: http.IncomingMessage) => {
  return new Promise((resolve) => {
    const bodyParts: Buffer[] = [];
    let body: string;
    request
      .on("data", (chunk) => {
        bodyParts.push(chunk);
      })
      .on("end", () => {
        body = Buffer.concat(bodyParts).toString();
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          console.error("[mcp-proxy] error parsing body", error);
          resolve(null);
        }
      });
  });
};

// Helper function to create JSON RPC error responses
const createJsonRpcErrorResponse = (code: number, message: string) => {
  return JSON.stringify({
    error: { code, message },
    id: null,
    jsonrpc: "2.0",
  });
};

// Helper function to get WWW-Authenticate header value
const getWWWAuthenticateHeader = (
  oauth?: AuthConfig["oauth"],
): string | undefined => {
  if (!oauth?.protectedResource?.resource) {
    return undefined;
  }

  return `Bearer resource_metadata="${oauth.protectedResource.resource}/.well-known/oauth-protected-resource"`;
};

// Helper function to handle Response errors and send appropriate HTTP response
const handleResponseError = (
  error: unknown,
  res: http.ServerResponse,
): boolean => {
  if (error instanceof Response) {
    const fixedHeaders: http.OutgoingHttpHeaders = {};
    error.headers.forEach((value, key) => {
      if (fixedHeaders[key]) {
        if (Array.isArray(fixedHeaders[key])) {
          (fixedHeaders[key] as string[]).push(value);
        } else {
          fixedHeaders[key] = [fixedHeaders[key] as string, value];
        }
      } else {
        fixedHeaders[key] = value;
      }
    });
    res
      .writeHead(error.status, error.statusText, fixedHeaders)
      .end(error.statusText);
    return true;
  }
  return false;
};

// Helper function to clean up server resources
const cleanupServer = async <T extends ServerLike>(
  server: T,
  onClose?: (server: T) => Promise<void>,
) => {
  if (onClose) {
    await onClose(server);
  }

  try {
    await server.close();
  } catch (error) {
    console.error("[mcp-proxy] error closing server", error);
  }
};

const handleStreamRequest = async <T extends ServerLike>({
  activeTransports,
  authenticate,
  createServer,
  enableJsonResponse,
  endpoint,
  eventStore,
  oauth,
  onClose,
  onConnect,
  req,
  res,
  stateless,
}: {
  activeTransports: Record<
    string,
    { server: T; transport: StreamableHTTPServerTransport }
  >;
  authenticate?: (request: http.IncomingMessage) => Promise<unknown>;
  createServer: (request: http.IncomingMessage) => Promise<T>;
  enableJsonResponse?: boolean;
  endpoint: string;
  eventStore?: EventStore;
  oauth?: AuthConfig["oauth"];
  onClose?: (server: T) => Promise<void>;
  onConnect?: (server: T) => Promise<void>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  stateless?: boolean;
}) => {
  if (
    req.method === "POST" &&
    new URL(req.url!, "http://localhost").pathname === endpoint
  ) {
    try {
      const sessionId = Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"];

      let transport: StreamableHTTPServerTransport;

      let server: T;

      const body = await getBody(req);

      // Per-request authentication in stateless mode
      if (stateless && authenticate) {
        try {
          const authResult = await authenticate(req);

          // Check for both falsy AND { authenticated: false } pattern
          if (!authResult || (typeof authResult === 'object' && 'authenticated' in authResult && !authResult.authenticated)) {
            // Extract error message if available
            const errorMessage =
              authResult && typeof authResult === 'object' && 'error' in authResult && typeof authResult.error === 'string'
                ? authResult.error
                : "Unauthorized: Authentication failed";

            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth);
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(
              JSON.stringify({
                error: {
                  code: -32000,
                  message: errorMessage
                },
                id: (body as { id?: unknown })?.id ?? null,
                jsonrpc: "2.0"
              })
            );
            return true;
          }
        } catch (error) {
          // Extract error details from thrown errors
          const errorMessage = error instanceof Error ? error.message : "Unauthorized: Authentication error";
          console.error("Authentication error:", error);
          res.setHeader("Content-Type", "application/json");

          // Add WWW-Authenticate header if OAuth config is available
          const wwwAuthHeader = getWWWAuthenticateHeader(oauth);
          if (wwwAuthHeader) {
            res.setHeader("WWW-Authenticate", wwwAuthHeader);
          }

          res.writeHead(401).end(
            JSON.stringify({
              error: {
                code: -32000,
                message: errorMessage
              },
              id: (body as { id?: unknown })?.id ?? null,
              jsonrpc: "2.0"
            })
          );
          return true;
        }
      }

      if (sessionId) {
        const activeTransport = activeTransports[sessionId];
        if (!activeTransport) {
          res.setHeader("Content-Type", "application/json");
          res
            .writeHead(404)
            .end(createJsonRpcErrorResponse(-32001, "Session not found"));

          return true;
        }

        transport = activeTransport.transport;
        server = activeTransport.server;
      } else if (!sessionId && isInitializeRequest(body)) {
        // Create a new transport for the session
        transport = new StreamableHTTPServerTransport({
          enableJsonResponse,
          eventStore: eventStore || new InMemoryEventStore(),
          onsessioninitialized: (_sessionId) => {
            // add only when the id Session id is generated (skip in stateless mode)
            if (!stateless && _sessionId) {
              activeTransports[_sessionId] = {
                server,
                transport,
              };
            }
          },
          sessionIdGenerator: stateless ? undefined : randomUUID,
        });

        // Handle the server close event
        let isCleaningUp = false;

        transport.onclose = async () => {
          const sid = transport.sessionId;

          if (isCleaningUp) {
            return;
          }

          isCleaningUp = true;

          if (!stateless && sid && activeTransports[sid]) {
            await cleanupServer(server, onClose);
            delete activeTransports[sid];
          } else if (stateless) {
            // In stateless mode, always call onClose when transport closes
            await cleanupServer(server, onClose);
          }
        };

        try {
          server = await createServer(req);
        } catch (error) {
          // Detect authentication errors and return HTTP 401
          const errorMessage = error instanceof Error ? error.message : String(error);
          const isAuthError = errorMessage.includes('Authentication') ||
                             errorMessage.includes('Invalid JWT') ||
                             errorMessage.includes('Token') ||
                             errorMessage.includes('Unauthorized');

          if (isAuthError) {
            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth);
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(JSON.stringify({
              error: {
                code: -32000,
                message: errorMessage
              },
              id: (body as { id?: unknown })?.id ?? null,
              jsonrpc: "2.0"
            }));
            return true;
          }

          if (handleResponseError(error, res)) {
            return true;
          }

          res.writeHead(500).end("Error creating server");

          return true;
        }

        server.connect(transport);

        if (onConnect) {
          await onConnect(server);
        }

        await transport.handleRequest(req, res, body);

        return true;
      } else if (stateless && !sessionId && !isInitializeRequest(body)) {
        // In stateless mode, handle non-initialize requests by creating a new transport
        transport = new StreamableHTTPServerTransport({
          enableJsonResponse,
          eventStore: eventStore || new InMemoryEventStore(),
          onsessioninitialized: () => {
            // No session tracking in stateless mode
          },
          sessionIdGenerator: undefined,
        });

        try {
          server = await createServer(req);
        } catch (error) {
          // Detect authentication errors and return HTTP 401
          const errorMessage = error instanceof Error ? error.message : String(error);
          const isAuthError = errorMessage.includes('Authentication') ||
                             errorMessage.includes('Invalid JWT') ||
                             errorMessage.includes('Token') ||
                             errorMessage.includes('Unauthorized');

          if (isAuthError) {
            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth);
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(JSON.stringify({
              error: {
                code: -32000,
                message: errorMessage
              },
              id: (body as { id?: unknown })?.id ?? null,
              jsonrpc: "2.0"
            }));
            return true;
          }

          if (handleResponseError(error, res)) {
            return true;
          }

          res.writeHead(500).end("Error creating server");

          return true;
        }

        server.connect(transport);

        if (onConnect) {
          await onConnect(server);
        }

        await transport.handleRequest(req, res, body);

        return true;
      } else {
        // Error if the server is not created but the request is not an initialize request
        res.setHeader("Content-Type", "application/json");

        res
          .writeHead(400)
          .end(
            createJsonRpcErrorResponse(
              -32000,
              "Bad Request: No valid session ID provided",
            ),
          );

        return true;
      }

      // Handle the request if the server is already created
      await transport.handleRequest(req, res, body);

      return true;
    } catch (error) {
      console.error("[mcp-proxy] error handling request", error);

      res.setHeader("Content-Type", "application/json");

      res
        .writeHead(500)
        .end(createJsonRpcErrorResponse(-32603, "Internal Server Error"));
    }
    return true;
  }

  if (
    req.method === "GET" &&
    new URL(req.url!, "http://localhost").pathname === endpoint
  ) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const activeTransport:
      | {
          server: T;
          transport: StreamableHTTPServerTransport;
        }
      | undefined = sessionId ? activeTransports[sessionId] : undefined;

    if (!sessionId) {
      res.writeHead(400).end("No sessionId");

      return true;
    }

    if (!activeTransport) {
      res.writeHead(400).end("No active transport");

      return true;
    }

    const lastEventId = req.headers["last-event-id"] as string | undefined;

    if (lastEventId) {
      console.log(
        `[mcp-proxy] client reconnecting with Last-Event-ID ${lastEventId} for session ID ${sessionId}`,
      );
    } else {
      console.log(
        `[mcp-proxy] establishing new SSE stream for session ID ${sessionId}`,
      );
    }

    await activeTransport.transport.handleRequest(req, res);

    return true;
  }

  if (
    req.method === "DELETE" &&
    new URL(req.url!, "http://localhost").pathname === endpoint
  ) {
    console.log("[mcp-proxy] received delete request");

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.writeHead(400).end("Invalid or missing sessionId");

      return true;
    }

    console.log("[mcp-proxy] received delete request for session", sessionId);

    const activeTransport = activeTransports[sessionId];

    if (!activeTransport) {
      res.writeHead(400).end("No active transport");
      return true;
    }

    try {
      await activeTransport.transport.handleRequest(req, res);

      await cleanupServer(activeTransport.server, onClose);
    } catch (error) {
      console.error("[mcp-proxy] error handling delete request", error);

      res.writeHead(500).end("Error handling delete request");
    }

    return true;
  }

  return false;
};

const handleSSERequest = async <T extends ServerLike>({
  activeTransports,
  createServer,
  endpoint,
  onClose,
  onConnect,
  req,
  res,
}: {
  activeTransports: Record<string, SSEServerTransport>;
  createServer: (request: http.IncomingMessage) => Promise<T>;
  endpoint: string;
  onClose?: (server: T) => Promise<void>;
  onConnect?: (server: T) => Promise<void>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) => {
  if (
    req.method === "GET" &&
    new URL(req.url!, "http://localhost").pathname === endpoint
  ) {
    const transport = new SSEServerTransport("/messages", res);

    let server: T;

    try {
      server = await createServer(req);
    } catch (error) {
      if (handleResponseError(error, res)) {
        return true;
      }

      res.writeHead(500).end("Error creating server");

      return true;
    }

    activeTransports[transport.sessionId] = transport;

    let closed = false;
    let isCleaningUp = false;

    res.on("close", async () => {
      closed = true;

      // Prevent recursive cleanup
      if (isCleaningUp) {
        return;
      }

      isCleaningUp = true;
      await cleanupServer(server, onClose);

      delete activeTransports[transport.sessionId];
    });

    try {
      await server.connect(transport);

      await transport.send({
        jsonrpc: "2.0",
        method: "sse/connection",
        params: { message: "SSE Connection established" },
      });

      if (onConnect) {
        await onConnect(server);
      }
    } catch (error) {
      if (!closed) {
        console.error("[mcp-proxy] error connecting to server", error);

        res.writeHead(500).end("Error connecting to server");
      }
    }

    return true;
  }

  if (req.method === "POST" && req.url?.startsWith("/messages")) {
    const sessionId = new URL(req.url, "https://example.com").searchParams.get(
      "sessionId",
    );

    if (!sessionId) {
      res.writeHead(400).end("No sessionId");

      return true;
    }

    const activeTransport: SSEServerTransport | undefined =
      activeTransports[sessionId];

    if (!activeTransport) {
      res.writeHead(400).end("No active transport");

      return true;
    }

    await activeTransport.handlePostMessage(req, res);

    return true;
  }

  return false;
};

export const startHTTPServer = async <T extends ServerLike>({
  apiKey,
  authenticate,
  createServer,
  enableJsonResponse,
  eventStore,
  host = "::",
  oauth,
  onClose,
  onConnect,
  onUnhandledRequest,
  port,
  sseEndpoint = "/sse",
  stateless,
  streamEndpoint = "/mcp",
}: {
  apiKey?: string;
  authenticate?: (request: http.IncomingMessage) => Promise<unknown>;
  createServer: (request: http.IncomingMessage) => Promise<T>;
  enableJsonResponse?: boolean;
  eventStore?: EventStore;
  host?: string;
  oauth?: AuthConfig["oauth"];
  onClose?: (server: T) => Promise<void>;
  onConnect?: (server: T) => Promise<void>;
  onUnhandledRequest?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
  port: number;
  sseEndpoint?: null | string;
  stateless?: boolean;
  streamEndpoint?: null | string;
}): Promise<SSEServer> => {
  const activeSSETransports: Record<string, SSEServerTransport> = {};

  const activeStreamTransports: Record<
    string,
    {
      server: T;
      transport: StreamableHTTPServerTransport;
    }
  > = {};

  const authMiddleware = new AuthenticationMiddleware({ apiKey, oauth });

  /**
   * @author https://dev.classmethod.jp/articles/mcp-sse/
   */
  const httpServer = http.createServer(async (req, res) => {
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);

        res.setHeader("Access-Control-Allow-Origin", origin.origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      } catch (error) {
        console.error("[mcp-proxy] error parsing origin", error);
      }
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === `/ping`) {
      res.writeHead(200).end("pong");
      return;
    }

    // Check authentication for all other endpoints
    if (!authMiddleware.validateRequest(req)) {
      const authResponse = authMiddleware.getUnauthorizedResponse();
      res.writeHead(401, authResponse.headers);
      res.end(authResponse.body);
      return;
    }

    if (
      sseEndpoint &&
      (await handleSSERequest({
        activeTransports: activeSSETransports,
        createServer,
        endpoint: sseEndpoint,
        onClose,
        onConnect,
        req,
        res,
      }))
    ) {
      return;
    }

    if (
      streamEndpoint &&
      (await handleStreamRequest({
        activeTransports: activeStreamTransports,
        authenticate,
        createServer,
        enableJsonResponse,
        endpoint: streamEndpoint,
        eventStore,
        oauth,
        onClose,
        onConnect,
        req,
        res,
        stateless,
      }))
    ) {
      return;
    }

    if (onUnhandledRequest) {
      await onUnhandledRequest(req, res);
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      resolve(undefined);
    });
  });

  return {
    close: async () => {
      for (const transport of Object.values(activeSSETransports)) {
        await transport.close();
      }

      for (const transport of Object.values(activeStreamTransports)) {
        await transport.transport.close();
      }

      return new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });
    },
  };
};
