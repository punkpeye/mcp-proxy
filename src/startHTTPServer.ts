import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  EventStore,
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import http from "http";
import https from "https";
import { randomUUID } from "node:crypto";

import { AuthConfig, AuthenticationMiddleware } from "./authentication.js";
import { InMemoryEventStore } from "./InMemoryEventStore.js";

export interface CorsOptions {
  allowedHeaders?: string | string[]; // Allow string[] or '*' for wildcard
  credentials?: boolean;
  exposedHeaders?: string[];
  maxAge?: number;
  methods?: string[];
  origin?: ((origin: string) => boolean) | string | string[];
}

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
  options?: {
    error?: string;
    error_description?: string;
    error_uri?: string;
    scope?: string;
  },
): string | undefined => {
  if (!oauth) {
    return undefined;
  }

  const params: string[] = [];

  // Add realm if configured
  if (oauth.realm) {
    params.push(`realm="${oauth.realm}"`);
  }

  // Add resource_metadata if configured
  if (oauth.protectedResource?.resource) {
    params.push(
      `resource_metadata="${oauth.protectedResource.resource}/.well-known/oauth-protected-resource"`,
    );
  }

  // Add error from options or config (options takes precedence)
  const error = options?.error || oauth.error;
  if (error) {
    params.push(`error="${error}"`);
  }

  // Add error_description from options or config (options takes precedence)
  const error_description =
    options?.error_description || oauth.error_description;
  if (error_description) {
    // Escape quotes in error description
    const escaped = error_description.replace(/"/g, '\\"');
    params.push(`error_description="${escaped}"`);
  }

  // Add error_uri from options or config (options takes precedence)
  const error_uri = options?.error_uri || oauth.error_uri;
  if (error_uri) {
    params.push(`error_uri="${error_uri}"`);
  }

  // Add scope from options or config (options takes precedence)
  const scope = options?.scope || oauth.scope;
  if (scope) {
    params.push(`scope="${scope}"`);
  }

  // Return undefined if no parameters were added
  if (params.length === 0) {
    return undefined;
  }

  return `Bearer ${params.join(", ")}`;
};

// Helper function to detect scope challenge errors
const isScopeChallengeError = (
  error: unknown,
): error is {
  data: {
    error: string;
    errorDescription?: string;
    requiredScopes: string[];
  };
  name: string;
} => {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "InsufficientScopeError" &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "error" in error.data &&
    error.data.error === "insufficient_scope"
  );
};

// Helper function to handle Response errors and send appropriate HTTP response
const handleResponseError = async (
  error: unknown,
  res: http.ServerResponse,
): Promise<boolean> => {
  // Check if it's a Response-like object (duck typing)
  // The instanceof check may fail due to different Response implementations across module boundaries
  const isResponseLike =
    error &&
    typeof error === "object" &&
    "status" in error &&
    "headers" in error &&
    "statusText" in error;

  if (isResponseLike || error instanceof Response) {
    const responseError = error as Response;

    // Convert Headers to http.OutgoingHttpHeaders format
    const fixedHeaders: http.OutgoingHttpHeaders = {};
    responseError.headers.forEach((value, key) => {
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

    // Read the body from the Response object
    const body = await responseError.text();

    res.writeHead(responseError.status, responseError.statusText, fixedHeaders);
    res.end(body);

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

// Helper function to apply CORS headers
const applyCorsHeaders = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOptions?: boolean | CorsOptions,
) => {
  if (!req.headers.origin) {
    return;
  }

  // Default CORS configuration for backward compatibility
  const defaultCorsOptions: CorsOptions = {
    allowedHeaders:
      "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-Id",
    credentials: true,
    exposedHeaders: ["Mcp-Session-Id"],
    methods: ["GET", "POST", "OPTIONS"],
    origin: "*",
  };

  let finalCorsOptions: CorsOptions;

  if (corsOptions === false) {
    // CORS disabled
    return;
  } else if (corsOptions === true || corsOptions === undefined) {
    // Use default CORS settings
    finalCorsOptions = defaultCorsOptions;
  } else {
    // Merge user options with defaults
    finalCorsOptions = {
      ...defaultCorsOptions,
      ...corsOptions,
    };
  }

  try {
    const origin = new URL(req.headers.origin);

    // Handle origin
    let allowedOrigin = "*";
    if (finalCorsOptions.origin) {
      if (typeof finalCorsOptions.origin === "string") {
        allowedOrigin = finalCorsOptions.origin;
      } else if (Array.isArray(finalCorsOptions.origin)) {
        allowedOrigin = finalCorsOptions.origin.includes(origin.origin)
          ? origin.origin
          : "false";
      } else if (typeof finalCorsOptions.origin === "function") {
        allowedOrigin = finalCorsOptions.origin(origin.origin)
          ? origin.origin
          : "false";
      }
    }

    if (allowedOrigin !== "false") {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }

    // Handle credentials
    if (finalCorsOptions.credentials !== undefined) {
      res.setHeader(
        "Access-Control-Allow-Credentials",
        finalCorsOptions.credentials.toString(),
      );
    }

    // Handle methods
    if (finalCorsOptions.methods) {
      res.setHeader(
        "Access-Control-Allow-Methods",
        finalCorsOptions.methods.join(", "),
      );
    }

    // Handle allowed headers
    if (finalCorsOptions.allowedHeaders) {
      const allowedHeaders =
        typeof finalCorsOptions.allowedHeaders === "string"
          ? finalCorsOptions.allowedHeaders
          : finalCorsOptions.allowedHeaders.join(", ");
      res.setHeader("Access-Control-Allow-Headers", allowedHeaders);
    }

    // Handle exposed headers
    if (finalCorsOptions.exposedHeaders) {
      res.setHeader(
        "Access-Control-Expose-Headers",
        finalCorsOptions.exposedHeaders.join(", "),
      );
    }

    // Handle max age
    if (finalCorsOptions.maxAge !== undefined) {
      res.setHeader(
        "Access-Control-Max-Age",
        finalCorsOptions.maxAge.toString(),
      );
    }
  } catch (error) {
    console.error("[mcp-proxy] error parsing origin", error);
  }
};

const handleStreamRequest = async <T extends ServerLike>({
  activeTransports,
  authenticate,
  authMiddleware,
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
  authMiddleware: AuthenticationMiddleware;
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
    let body: unknown;
    try {
      const sessionId = Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"];

      let transport: StreamableHTTPServerTransport;

      let server: T;

      body = await getBody(req);

      // Per-request authentication for all requests
      // Store authResult to update existing sessions with fresh auth context
      let authResult: unknown;
      if (authenticate) {
        try {
          authResult = await authenticate(req);

          // Check for both falsy AND { authenticated: false } pattern
          if (
            !authResult ||
            (typeof authResult === "object" &&
              "authenticated" in authResult &&
              !authResult.authenticated)
          ) {
            // Extract error message if available
            const errorMessage =
              authResult &&
              typeof authResult === "object" &&
              "error" in authResult &&
              typeof authResult.error === "string"
                ? authResult.error
                : "Unauthorized: Authentication failed";

            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth, {
              error: "invalid_token",
              error_description: errorMessage,
            });
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(
              JSON.stringify({
                error: {
                  code: -32000,
                  message: errorMessage,
                },
                id: (body as { id?: unknown })?.id ?? null,
                jsonrpc: "2.0",
              }),
            );
            return true;
          }
        } catch (error) {
          // Check if error is a Response object with headers already set
          if (await handleResponseError(error, res)) {
            return true;
          }

          // Extract error details from thrown errors
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Unauthorized: Authentication error";
          console.error("Authentication error:", error);
          res.setHeader("Content-Type", "application/json");

          // Add WWW-Authenticate header if OAuth config is available
          const wwwAuthHeader = getWWWAuthenticateHeader(oauth, {
            error: "invalid_token",
            error_description: errorMessage,
          });
          if (wwwAuthHeader) {
            res.setHeader("WWW-Authenticate", wwwAuthHeader);
          }

          res.writeHead(401).end(
            JSON.stringify({
              error: {
                code: -32000,
                message: errorMessage,
              },
              id: (body as { id?: unknown })?.id ?? null,
              jsonrpc: "2.0",
            }),
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

        // Update session's auth context with fresh authentication result
        if (
          authResult &&
          typeof server === "object" &&
          server !== null &&
          "updateAuth" in server &&
          typeof (server as { updateAuth?: unknown }).updateAuth === "function"
        ) {
          (server as { updateAuth: (auth: unknown) => void }).updateAuth(
            authResult,
          );
        }
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
          // Check if error is a Response object with headers already set
          if (await handleResponseError(error, res)) {
            return true;
          }

          // Detect authentication errors and return HTTP 401
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const isAuthError =
            errorMessage.includes("Authentication") ||
            errorMessage.includes("Invalid JWT") ||
            errorMessage.includes("Token") ||
            errorMessage.includes("Unauthorized");

          if (isAuthError) {
            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth, {
              error: "invalid_token",
              error_description: errorMessage,
            });
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(
              JSON.stringify({
                error: {
                  code: -32000,
                  message: errorMessage,
                },
                id: (body as { id?: unknown })?.id ?? null,
                jsonrpc: "2.0",
              }),
            );
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
          // Check if error is a Response object with headers already set
          if (await handleResponseError(error, res)) {
            return true;
          }

          // Detect authentication errors and return HTTP 401
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const isAuthError =
            errorMessage.includes("Authentication") ||
            errorMessage.includes("Invalid JWT") ||
            errorMessage.includes("Token") ||
            errorMessage.includes("Unauthorized");

          if (isAuthError) {
            res.setHeader("Content-Type", "application/json");

            // Add WWW-Authenticate header if OAuth config is available
            const wwwAuthHeader = getWWWAuthenticateHeader(oauth, {
              error: "invalid_token",
              error_description: errorMessage,
            });
            if (wwwAuthHeader) {
              res.setHeader("WWW-Authenticate", wwwAuthHeader);
            }

            res.writeHead(401).end(
              JSON.stringify({
                error: {
                  code: -32000,
                  message: errorMessage,
                },
                id: (body as { id?: unknown })?.id ?? null,
                jsonrpc: "2.0",
              }),
            );
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
      // Check for scope challenge errors
      if (isScopeChallengeError(error)) {
        const response = authMiddleware.getScopeChallengeResponse(
          error.data.requiredScopes,
          error.data.errorDescription,
          (body as { id?: unknown })?.id,
        );

        res.writeHead(response.statusCode, response.headers);
        res.end(response.body);
        return true;
      }

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
      if (await handleResponseError(error, res)) {
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
        method: "notifications/message",
        params: { data: "SSE Connection established", level: "info" },
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
  cors,
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
  sslCa,
  sslCert,
  sslKey,
  stateless,
  streamEndpoint = "/mcp",
}: {
  apiKey?: string;
  authenticate?: (request: http.IncomingMessage) => Promise<unknown>;
  cors?: boolean | CorsOptions;
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
  sslCa?: null | string;
  sslCert?: null | string;
  sslKey?: null | string;
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
  const requestListener: http.RequestListener = async (req, res) => {
    // Apply CORS headers
    applyCorsHeaders(req, res, cors);

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
        authMiddleware,
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
  };

  let httpServer;
  if (sslCa || sslCert || sslKey) {
    const options: https.ServerOptions = {};
    if (sslCa) {
      try {
        options.ca = fs.readFileSync(sslCa);
      } catch (error) {
        throw new Error(
          `Failed to read CA file '${sslCa}': ${(error as Error).message}`,
        );
      }
    }
    if (sslCert) {
      try {
        options.cert = fs.readFileSync(sslCert);
      } catch (error) {
        throw new Error(
          `Failed to read certificate file '${sslCert}': ${(error as Error).message}`,
        );
      }
    }
    if (sslKey) {
      try {
        options.key = fs.readFileSync(sslKey);
      } catch (error) {
        throw new Error(
          `Failed to read key file '${sslKey}': ${(error as Error).message}`,
        );
      }
    }
    httpServer = https.createServer(options, requestListener);
  } else {
    httpServer = http.createServer(requestListener);
  }

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
