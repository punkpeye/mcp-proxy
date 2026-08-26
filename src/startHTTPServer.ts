import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  EventStore,
  isInitializeRequest,
  isLegacyRequest,
  McpHttpHandler,
  Server,
  ServerNotifier,
} from "@modelcontextprotocol/server";
// The v2 SDK removed the HTTP+SSE transport; `server-legacy` is a frozen copy
// of the v1 one, published deprecated and receiving no new features. It is the
// only way to keep serving `/sse`, which 2025-era clients still use. The
// transport is deprecated as of 2026-07-28 with a twelve-month window - when
// that closes, this import and the SSE endpoint go with it.
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import fs from "fs";
import http from "http";
import https from "https";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { AuthConfig, AuthenticationMiddleware } from "./authentication.js";
import { InMemoryEventStore } from "./InMemoryEventStore.js";

const DEFAULT_KEEP_ALIVE_TIMEOUT = 300_000;

/**
 * How long a 2025-era stream session with nothing attached to it is kept before
 * the reaper closes it.
 *
 * Generous on purpose. The only thing a session with no attached stream can
 * still do is serve a `Last-Event-ID` resumption, and the default event store
 * is per-session, in-memory and capped, so a client returning half an hour
 * later has little to come back to. Weighed against that, sessions that are
 * never reclaimed accumulate for the life of the process.
 */
const DEFAULT_SESSION_IDLE_TIMEOUT = 1_800_000;

/**
 * How often the reaper looks. Independent of the timeout, so the sweep stays
 * cheap when the timeout is long; clamped to the timeout when it is short.
 */
const SESSION_SWEEP_INTERVAL = 60_000;

/**
 * How long `close()` waits for still-running requests before destroying what is
 * left. Well under the CLI's 5s graceful-shutdown budget, so a forced close
 * still leaves room for the process to exit cleanly.
 */
const FORCE_CLOSE_GRACE_PERIOD = 1_000;

/**
 * `false` disables the resumability event store entirely (no replay-on-
 * reconnect, no retained state). Omitted/`undefined` creates a fresh,
 * bounded `InMemoryEventStore` per session - see `eventStoreMaxEvents`.
 * Pass an `EventStore` instance to use a shared or custom-backed store.
 */
export type EventStoreOption = EventStore | false;

const resolveEventStore = (
  eventStore: EventStoreOption | undefined,
  maxEvents: number | undefined,
): EventStore | undefined => {
  if (eventStore === false) {
    return undefined;
  }

  return eventStore ?? new InMemoryEventStore({ maxEvents });
};

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
  /**
   * Publishes a change event to every open 2026-07-28 `subscriptions/listen`
   * stream. That revision delivers `list_changed` and `resources/updated` only
   * on a stream the client asked for, so there is no per-connection `Server` to
   * send them through - they are published here instead.
   *
   * A no-op when the modern leg is disabled.
   */
  notify: ServerNotifier;
};

/** Stand-in for `notify` when no modern leg exists to publish to. */
const NO_MODERN_SUBSCRIBERS: ServerNotifier = {
  promptsChanged: () => {},
  resourcesChanged: () => {},
  resourceUpdated: () => {},
  toolsChanged: () => {},
};

type ServerLike = {
  close: Server["close"];
  connect: Server["connect"];
};

/**
 * `Access-Control-Allow-Headers` when CORS is left at its defaults.
 *
 * `Mcp-Method`/`Mcp-Name` are required on 2026-07-28 Streamable HTTP POSTs
 * (SEP-2243); without them a browser client's preflight fails before the
 * request is ever classified. The revision's `Mcp-Param-*` headers are a
 * prefix, which `Access-Control-Allow-Headers` cannot express - a deployment
 * whose tools declare `x-mcp-header` params adds those names explicitly
 * (`--corsAddAllowedHeader` / `cors.allowedHeaders`).
 */
export const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Last-Event-Id",
  "Mcp-Method",
  "Mcp-Name",
];

const DEFAULT_MAX_BODY_SIZE = 10_485_760; // 10 MiB

/**
 * Caps how many bytes of a request body the stream endpoint buffers before it
 * gives up. `false` (or `0` from the CLI) disables the cap entirely, restoring
 * unbounded buffering - only do that behind a gateway that already limits body
 * size. Omitted/`undefined` uses `DEFAULT_MAX_BODY_SIZE`.
 */
export type MaxBodySizeOption = false | number;

/**
 * "Too large" is kept distinct from the `null` that every other unusable body
 * resolves to, so the caller can answer 413 rather than let it fall through to
 * the generic 400. The limit travels with the signal so the response can name
 * it.
 */
type BodyResult =
  | { readonly body: unknown; readonly tooLarge?: never }
  | { readonly limit: number; readonly tooLarge: true };

export const getBody = (
  request: http.IncomingMessage,
  maxBodySize: MaxBodySizeOption = DEFAULT_MAX_BODY_SIZE,
) => {
  return new Promise<BodyResult>((resolve) => {
    if (maxBodySize !== false) {
      // A client that declares its size up front can be rejected before a
      // single byte of body is read. The streaming check below is still
      // needed for chunked bodies and for clients that under-declare.
      const declaredSize = Number(request.headers["content-length"]);

      if (Number.isFinite(declaredSize) && declaredSize > maxBodySize) {
        resolve({ limit: maxBodySize, tooLarge: true });

        return;
      }
    }

    const bodyParts: Buffer[] = [];
    let body: string;
    let size = 0;
    request
      .on("data", (chunk) => {
        if (maxBodySize !== false) {
          size += chunk.length;
          if (size > maxBodySize) {
            // Stop reading immediately so the socket applies TCP backpressure
            // instead of this process buffering an unbounded oversize body.
            // Without this the stream stays in flowing mode and keeps
            // emitting "data" after the promise settles, racing the 413
            // teardown in sendPayloadTooLarge.
            request.pause();
            resolve({ limit: maxBodySize, tooLarge: true });
            return;
          }
        }
        bodyParts.push(chunk);
      })
      .on("end", () => {
        body = Buffer.concat(bodyParts).toString();
        try {
          resolve({ body: JSON.parse(body) });
        } catch (error) {
          console.error("[mcp-proxy] error parsing body", error);
          resolve({ body: null });
        }
      })
      .on("error", (error) => {
        console.error("[mcp-proxy] error reading body", error);
        resolve({ body: null });
      })
      .on("close", () => {
        resolve({ body: null });
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

/**
 * Answers an over-sized request with a 413 and only then tears the connection
 * down. Destroying the socket outright - which is all the size check can do on
 * its own - leaves the client with a bare ECONNRESET and no way to tell a size
 * limit from a crash.
 */
const sendPayloadTooLarge = ({
  maxBodySize,
  req,
  res,
}: {
  readonly maxBodySize: number;
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
}) => {
  console.error(
    `[mcp-proxy] request body too large (exceeds ${maxBodySize} bytes)`,
  );

  // Stop consuming immediately so a client that keeps sending applies TCP
  // backpressure instead of growing this process's buffers.
  req.pause();

  if (res.headersSent) {
    req.destroy();

    return;
  }

  res.setHeader("Connection", "close");
  res.setHeader("Content-Type", "application/json");

  // Destroy only once the response has flushed, otherwise the socket can go
  // away before the client ever sees the 413.
  res.writeHead(413).end(
    createJsonRpcErrorResponse(
      -32600,
      `Payload Too Large: request body exceeds ${maxBodySize} bytes`,
    ),
    () => {
      req.destroy();
    },
  );
};

type SessionUnauthorizedResponseOptions = {
  readonly body?: unknown;
  readonly oauth?: AuthConfig["oauth"];
  readonly res: http.ServerResponse;
};

const getRequestId = (body: unknown): unknown => {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("id" in body)
  ) {
    return null;
  }

  return body.id;
};

const isJsonRpcMessage = (message: unknown): boolean => {
  return JSONRPCMessageSchema.safeParse(message).success;
};

const isJsonRpcBody = (body: unknown): boolean => {
  return Array.isArray(body)
    ? body.every(isJsonRpcMessage)
    : isJsonRpcMessage(body);
};

/** `[].every` is vacuously true, so an empty batch passes `isJsonRpcBody`. */
const isEmptyBatch = (body: unknown): boolean =>
  Array.isArray(body) && body.length === 0;

/**
 * The resource URIs a `subscriptions/listen` asked to be notified about, or an
 * empty list for any other request.
 */
const readListenSubscriptions = (body: unknown): string[] => {
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { method?: unknown }).method !== "subscriptions/listen"
  ) {
    return [];
  }

  // The filter travels as `params.notifications`, not `params.filter` - the
  // latter is the name of the argument `client.listen()` takes, not the wire
  // field it becomes.
  const uris = (
    body as {
      params?: { notifications?: { resourceSubscriptions?: unknown } };
    }
  ).params?.notifications?.resourceSubscriptions;

  return Array.isArray(uris)
    ? uris.filter((uri): uri is string => typeof uri === "string")
    : [];
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

const sendSessionUnauthorizedResponse = ({
  body,
  oauth,
  res,
}: SessionUnauthorizedResponseOptions): void => {
  const message = "Unauthorized: No valid session ID provided";

  res.setHeader("Content-Type", "application/json");

  const wwwAuthHeader = getWWWAuthenticateHeader(oauth, {
    error: "invalid_token",
    error_description: message,
  });
  if (wwwAuthHeader) {
    res.setHeader("WWW-Authenticate", wwwAuthHeader);
  }

  res.writeHead(401).end(
    JSON.stringify({
      error: {
        code: -32000,
        message,
      },
      id: getRequestId(body),
      jsonrpc: "2.0",
    }),
  );
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

/**
 * Answers a `createServer` failure. A thrown `Response` is passed through
 * verbatim (the convention consumers use to reject a request with their own
 * status and headers); otherwise an auth-shaped message becomes a 401 and
 * anything else a 500.
 *
 * Shared by both eras so a consumer's rejection means the same thing on either
 * leg - on the 2026-07-28 leg this must run outside the SDK's request handler,
 * which would otherwise turn any throw into an opaque 500.
 */
const handleCreateServerError = async ({
  body,
  error,
  oauth,
  res,
}: {
  body: unknown;
  error: unknown;
  oauth?: AuthConfig["oauth"];
  res: http.ServerResponse;
}): Promise<void> => {
  if (await handleResponseError(error, res)) {
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const isAuthError =
    errorMessage.includes("Authentication") ||
    errorMessage.includes("Invalid JWT") ||
    errorMessage.includes("Token") ||
    errorMessage.includes("Unauthorized");

  if (isAuthError) {
    res.setHeader("Content-Type", "application/json");

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
        id: getRequestId(body),
        jsonrpc: "2.0",
      }),
    );

    return;
  }

  res.writeHead(500).end("Error creating server");
};

// Helper function to clean up server resources
const cleanupServer = async <T extends ServerLike>(
  server: T,
  onClose?: (server: T) => Promise<void>,
) => {
  if (onClose) {
    // Contained, because the caller is `transport.onclose`, which the SDK
    // invokes without awaiting: a rejection here would surface as an unhandled
    // rejection - fatal under Node's default - and would abandon the rest of
    // teardown, leaving the session in `activeTransports` with its cleanup
    // flag already set, so nothing would ever retry it. The 2026-07-28 leg
    // contains its `onClose` for the same reason.
    try {
      await onClose(server);
    } catch (error) {
      console.error("[mcp-proxy] error in onClose", error);
    }
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
    allowedHeaders: DEFAULT_ALLOWED_HEADERS.join(", "),
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

    // An array or function origin resolves per request, so the response is
    // origin-dependent whether or not this one was allowed - a shared cache
    // that missed that would hand one origin's answer to another.
    res.setHeader("Vary", "Origin");

    if (allowedOrigin !== "false") {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }

    // Handle credentials
    // The Fetch Standard forbids pairing `Access-Control-Allow-Credentials`
    // with a wildcard origin
    // (https://fetch.spec.whatwg.org/#http-access-control-allow-credentials):
    // a browser rejects the entire CORS response when it sees both, so the
    // header grants nothing and only breaks callers that would otherwise be
    // fine. Reflecting the request origin instead would "fix" it by handing
    // every origin a working credentialed grant, which is not something a
    // wildcard default should imply - configure an explicit `origin` to use
    // credentials.
    if (finalCorsOptions.credentials !== undefined && allowedOrigin !== "*") {
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

/**
 * The 2026-07-28 leg. Kept behind the same endpoint as the 2025-era leg so a
 * single URL serves both: `handleStreamRequest` classifies each POST and only
 * reaches `handle` for requests carrying the modern `_meta` envelope.
 */
/**
 * Called with the resource URIs an incoming `subscriptions/listen` asked to be
 * notified about, and returns a function that releases them.
 *
 * The 2026-07-28 revision has no `resources/subscribe`: a client expresses the
 * same intent through the `resourceSubscriptions` field of its listen filter,
 * which the serving entry answers itself. A proxy still has to act on it -
 * otherwise the filter is acknowledged and nothing upstream is ever subscribed,
 * so the client waits for updates that cannot arrive. The release runs when the
 * stream ends.
 */
export type ListenSubscriptionsHandler = (
  uris: string[],
) => Promise<() => void>;

/**
 * The instance serving one modern request, plus the teardown that releases it.
 *
 * `createServer` runs before the handler rather than inside its factory for two
 * reasons. It lets a throw reach the caller, which answers it exactly as the
 * 2025-era legs do (a thrown `Response` is honored, an auth-shaped error becomes
 * a 401) instead of becoming an opaque 500 from inside the SDK. And it puts the
 * instance's lifetime in our hands: the `subscriptions/listen` path builds an
 * instance the SDK closes without ever attaching a transport, and `close()` on a
 * transport-less instance is a no-op that never fires `onclose` - so hanging
 * teardown off `onclose` alone leaks the instance and everything registered on
 * it, once per opened stream, forever.
 */
type ModernInstance<T> = {
  server: T;
  teardown: () => void;
};

type ModernLeg<T> = {
  close: () => Promise<void>;
  /** Throws whatever `createServer` throws, for the caller to answer. */
  createInstance: (context: {
    authResult: unknown;
    body: unknown;
    req: http.IncomingMessage;
  }) => Promise<ModernInstance<T>>;
  handle: (
    instance: ModernInstance<T>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ) => Promise<void>;
  notify: ServerNotifier;
};

/**
 * `createMcpHandler`'s factory is handed an era, not the underlying Node
 * request, but `createServer` is defined in terms of that request (consumers
 * derive per-request auth and context from it). `AsyncLocalStorage` carries the
 * already-built instance across the boundary; the store is established for the
 * whole `fetch` call, so every async continuation inside the factory sees it.
 */
const createModernLeg = <T extends ServerLike>({
  createServer,
  onClose,
  onConnect,
  onListenSubscriptions,
}: {
  createServer: (request: http.IncomingMessage) => Promise<T>;
  onClose?: (server: T) => Promise<void>;
  onConnect?: (server: T) => Promise<void>;
  onListenSubscriptions?: ListenSubscriptionsHandler;
}): ModernLeg<T> => {
  const requestContext = new AsyncLocalStorage<ModernInstance<T>>();

  const createInstance = async ({
    authResult,
    body,
    req,
  }: {
    authResult: unknown;
    body: unknown;
    req: http.IncomingMessage;
  }): Promise<ModernInstance<T>> => {
    const server = await createServer(req);

    // Everything below can throw, and by then `createServer` has already
    // registered whatever it registers - `proxyServer` adds an upstream
    // notification sink here. Teardown is therefore defined before the first
    // thing that can fail, so the catch can release the instance instead of
    // stranding it: nothing else will, because a failed `createInstance` never
    // reaches `handle`, and `close()` on an instance the SDK never attached a
    // transport to does not fire `onclose`.
    const target = server as unknown as Server;
    const previousOnClose = target.onclose;

    let releaseSubscriptions: (() => void) | undefined;
    let toreDown = false;

    // Idempotent, because it runs both from the instance's own `onclose` (when
    // a transport was attached and closed it) and from `handle`'s teardown.
    const teardown = () => {
      if (toreDown) {
        return;
      }

      toreDown = true;

      releaseSubscriptions?.();

      // Whatever the consumer's `createServer` registered - `proxyServer` uses
      // this to release its upstream notification sink.
      previousOnClose?.();

      if (onClose) {
        void onClose(server).catch((error: unknown) => {
          console.error("[mcp-proxy] error in onClose", error);
        });
      }
    };

    target.onclose = teardown;

    try {
      if (onListenSubscriptions) {
        const listenUris = readListenSubscriptions(body);

        if (listenUris.length > 0) {
          releaseSubscriptions = await onListenSubscriptions(listenUris);
        }
      }

      // Same convention the 2025-era leg uses for a session's auth context;
      // `authResult` is the consumer's own value, not an SDK `AuthInfo`.
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

      if (onConnect) {
        await onConnect(server);
      }
    } catch (error) {
      await server.close().catch(() => undefined);

      teardown();

      throw error;
    }

    return { server, teardown };
  };

  const handler: McpHttpHandler = createMcpHandler(
    () => {
      const instance = requestContext.getStore();

      if (!instance) {
        throw new Error(
          "[mcp-proxy] modern handler invoked outside of a request context",
        );
      }

      // `ServerLike` is structural; the factory contract wants the real class,
      // which is what every caller actually passes.
      return instance.server as unknown as Server;
    },
    {
      // The 2025-era leg below is sessionful, so the entry must not also serve
      // legacy traffic - `handleStreamRequest` routes it there instead.
      legacy: "reject",
      onerror: (error) => {
        console.error("[mcp-proxy] modern handler error", error);
      },
    },
  );

  const nodeHandler = toNodeHandler({
    fetch: (request, options) => handler.fetch(request, options),
  });

  return {
    close: () => handler.close(),
    createInstance,
    handle: async (instance, req, res, body) => {
      try {
        await requestContext.run(instance, () => nodeHandler(req, res, body));
      } finally {
        // Resolves only once the response - including a streamed one - is
        // fully written, so this is the end of the exchange, not the middle.
        try {
          await instance.server.close();
        } catch (error) {
          console.error("[mcp-proxy] error closing modern instance", error);
        }

        instance.teardown();
      }
    },
    notify: handler.notify,
  };
};

/**
 * One 2025-era stream session, plus the two signals the reaper reads to decide
 * whether the client behind it still exists.
 *
 * A session deliberately outlives the connection that created it - that is what
 * makes replay-on-reconnect possible - so a dropped socket is not by itself the
 * end of a session, and the SDK does not treat it as one. What is missing is
 * anything that ever decides the client is not coming back, and deciding that
 * takes both fields: `openStreams` alone would reap a client that is mid-
 * request, and `lastActivityAt` alone would reap a client parked on an open
 * notification stream making no requests, which is an ordinary thing for a
 * stateful client to do and exactly what `keepAliveTimeout` exists to protect.
 */
type StreamSession<T> = {
  /**
   * Set once the reaper has closed this session. The entry outlives that call -
   * the SDK's `close()` does not await the `onclose` that removes it - so
   * without this a slow teardown would be re-selected and re-closed by every
   * sweep it spans.
   */
  closing: boolean;
  /**
   * When this session last received a request or finished a response. Only
   * consulted while `openStreams` is 0; an attached stream keeps the session
   * alive however stale this is.
   */
  lastActivityAt: number;
  /** Responses currently attached to this session, streaming or not. */
  openStreams: number;
  server: T;
  transport: NodeStreamableHTTPServerTransport;
};

/**
 * Marks a session busy for as long as `res` is attached, and stamps the idle
 * clock at both ends.
 *
 * The stamp on close is the one that matters. A dropped connection ends the
 * response, so it starts the countdown at the moment the client actually went
 * away rather than at its last request - without which a client that sat on a
 * quiet stream for an hour would be counted an hour stale the instant it drops,
 * and reaped before it could resume.
 */
const trackSessionStream = <T>(
  session: StreamSession<T>,
  res: http.ServerResponse,
) => {
  session.lastActivityAt = Date.now();

  // A connection already gone by the time we get here has emitted `close`
  // as well, so subscribing now would hold the count above zero forever and
  // make the session immortal - the leak this is here to prevent.
  if (res.closed) {
    return;
  }

  session.openStreams += 1;

  // Fires for a completed response and an aborted one alike, so the count
  // cannot be stranded by a client vanishing mid-stream.
  res.once("close", () => {
    session.lastActivityAt = Date.now();
    session.openStreams -= 1;
  });
};

/**
 * Closes sessions whose client is gone.
 *
 * Teardown runs through `transport.close()` rather than dropping the entry, so
 * a reaped session takes the same path a `DELETE` takes: the transport's
 * `onclose` is what invokes `onClose`, closes the `Server` - which is where
 * `proxyServer` releases its upstream subscription lease - and removes the
 * entry. Nothing here has to know about any of that.
 */
const reapIdleSessions = async <T>(
  sessions: Record<string, StreamSession<T>>,
  idleTimeout: number,
) => {
  const now = Date.now();

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (
      session.closing ||
      session.openStreams > 0 ||
      now - session.lastActivityAt <= idleTimeout
    ) {
      continue;
    }

    console.log(
      `[mcp-proxy] closing session ${sessionId}, idle for over ${idleTimeout}ms`,
    );

    // Marked before rather than after, because `close()` returns as soon as it
    // has handed off to `onclose` - the entry is still here at that point, and
    // stays until teardown finishes.
    session.closing = true;

    await session.transport.close();
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
  eventStoreMaxEvents,
  maxBodySize,
  modernHandler,
  oauth,
  onClose,
  onConnect,
  req,
  res,
  stateless,
}: {
  activeTransports: Record<string, StreamSession<T>>;
  authenticate?: (request: http.IncomingMessage) => Promise<unknown>;
  authMiddleware: AuthenticationMiddleware;
  createServer: (request: http.IncomingMessage) => Promise<T>;
  enableJsonResponse?: boolean;
  endpoint: string;
  eventStore?: EventStoreOption;
  eventStoreMaxEvents?: number;
  maxBodySize?: MaxBodySizeOption;
  modernHandler?: ModernLeg<T>;
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
      // In stateless mode, ignore session ID header entirely (like Python MCP SDK)
      const sessionId = stateless
        ? undefined
        : Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0]
          : req.headers["mcp-session-id"];

      // Claimed here rather than at the session lookup below, because
      // everything in between can wait: reading a slow or large body,
      // `authenticate`, the modern leg's classification. A request that has
      // been on the wire longer than the idle timeout would otherwise be
      // answered with `Session not found` after uploading successfully,
      // its session reaped out from under it.
      const pendingSession = sessionId
        ? activeTransports[sessionId]
        : undefined;

      if (pendingSession) {
        trackSessionStream(pendingSession, res);
      }

      let transport: NodeStreamableHTTPServerTransport;

      let server: T;

      const bodyResult = await getBody(req, maxBodySize);

      if (bodyResult.tooLarge) {
        sendPayloadTooLarge({ maxBodySize: bodyResult.limit, req, res });

        return true;
      }

      body = bodyResult.body;

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

      // Era classification, once, at the entry boundary. `isLegacyRequest` is
      // the SDK's own routing predicate rather than a re-implementation, so
      // this branch cannot disagree with what the modern handler would do.
      // Non-POST verbs never reach here; they have no envelope and belong to
      // the 2025-era session machinery below either way.
      //
      // `isLegacyRequest` is false for anything it cannot positively call
      // legacy, which includes a body that is not a JSON-RPC message at all.
      // Those are not 2026-07-28 traffic and must keep the answer they have
      // always had, so only well-formed messages are offered to the modern
      // leg - a valid message carrying a malformed envelope still goes there,
      // which is where the spec says it should be diagnosed.
      // An empty batch is neither era's traffic; excluding it here keeps the
      // answer a 2025 client already gets rather than handing it to a leg that
      // classifies it as a rejection.
      if (modernHandler && isJsonRpcBody(body) && !isEmptyBatch(body)) {
        // The parsed body is passed to both calls: `toWebRequest` would
        // otherwise re-serialize it and `isLegacyRequest` would clone, read and
        // re-parse it, on every request of either era.
        const webRequest = await toWebRequest(req, body);

        if (!(await isLegacyRequest(webRequest, body))) {
          let instance;

          try {
            instance = await modernHandler.createInstance({
              authResult,
              body,
              req,
            });
          } catch (error) {
            await handleCreateServerError({ body, error, oauth, res });

            return true;
          }

          await modernHandler.handle(instance, req, res, body);

          return true;
        }
      }

      if (sessionId) {
        const activeTransport = activeTransports[sessionId];
        if (!activeTransport) {
          if (authenticate && isJsonRpcBody(body)) {
            sendSessionUnauthorizedResponse({ body, oauth, res });

            return true;
          }

          res.setHeader("Content-Type", "application/json");
          res
            .writeHead(404)
            .end(createJsonRpcErrorResponse(-32001, "Session not found"));

          return true;
        }

        transport = activeTransport.transport;
        server = activeTransport.server;

        // Already claimed above, before the first await.

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
        transport = new NodeStreamableHTTPServerTransport({
          enableJsonResponse,
          eventStore: resolveEventStore(eventStore, eventStoreMaxEvents),
          onsessioninitialized: (_sessionId) => {
            // add only when the id Session id is generated (skip in stateless mode)
            if (!stateless && _sessionId) {
              const session: StreamSession<T> = {
                closing: false,
                lastActivityAt: Date.now(),
                openStreams: 0,
                server,
                transport,
              };

              activeTransports[_sessionId] = session;

              // The `initialize` response is this session's first attached
              // stream. Counting it here rather than at the shared
              // `handleRequest` below is what keeps a session created and then
              // immediately abandoned from starting life at zero activity.
              trackSessionStream(session, res);
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
          await handleCreateServerError({ body, error, oauth, res });

          return true;
        }

        try {
          await server.connect(transport);

          if (onConnect) {
            await onConnect(server);
          }
        } catch (error) {
          // `cleanupServer` closes the server, which closes the transport it
          // just attached, which re-enters the `onclose` handler above - and
          // that leg cleans up unconditionally in stateless mode. Claim the
          // flag first so it bails instead of running `onClose` a second time.
          if (!isCleaningUp) {
            isCleaningUp = true;

            await cleanupServer(server, onClose);
          }

          throw error;
        }

        await transport.handleRequest(req, res, body);

        return true;
      } else if (stateless && !sessionId && !isInitializeRequest(body)) {
        // In stateless mode, handle non-initialize requests by creating a new transport
        transport = new NodeStreamableHTTPServerTransport({
          enableJsonResponse,
          eventStore: resolveEventStore(eventStore, eventStoreMaxEvents),
          onsessioninitialized: () => {
            // No session tracking in stateless mode
          },
          sessionIdGenerator: undefined,
        });

        try {
          server = await createServer(req);
        } catch (error) {
          await handleCreateServerError({ body, error, oauth, res });

          return true;
        }

        try {
          await server.connect(transport);

          if (onConnect) {
            await onConnect(server);
          }
        } catch (error) {
          await cleanupServer(server, onClose);
          throw error;
        }

        await transport.handleRequest(req, res, body);

        return true;
      } else {
        if (authenticate && isJsonRpcBody(body)) {
          sendSessionUnauthorizedResponse({ body, oauth, res });

          return true;
        }

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
    const activeTransport: StreamSession<T> | undefined = sessionId
      ? activeTransports[sessionId]
      : undefined;

    if (!sessionId) {
      // Return METHOD_NOT_ALLOWED so stateless clients' transport stops reconnecting
      if (stateless) {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");

        return true;
      }

      if (authenticate) {
        sendSessionUnauthorizedResponse({ oauth, res });

        return true;
      }

      res.writeHead(400).end("No sessionId");

      return true;
    }

    if (!activeTransport) {
      if (authenticate) {
        sendSessionUnauthorizedResponse({ oauth, res });

        return true;
      }

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

    trackSessionStream(activeTransport, res);

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
      if (authenticate) {
        sendSessionUnauthorizedResponse({ oauth, res });

        return true;
      }

      res.writeHead(400).end("Invalid or missing sessionId");

      return true;
    }

    console.log("[mcp-proxy] received delete request for session", sessionId);

    const activeTransport = activeTransports[sessionId];

    if (!activeTransport) {
      if (authenticate) {
        sendSessionUnauthorizedResponse({ oauth, res });

        return true;
      }

      res.writeHead(400).end("No active transport");
      return true;
    }

    try {
      // handleRequest for DELETE calls transport.close() internally,
      // which triggers the transport.onclose callback that already
      // handles server cleanup. No need to call cleanupServer again.
      await activeTransport.transport.handleRequest(req, res);
    } catch (error) {
      console.error("[mcp-proxy] error handling delete request", error);

      if (!res.headersSent) {
        res.writeHead(500).end("Error handling delete request");
      }
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

        if (!res.headersSent) {
          res.writeHead(500).end("Error connecting to server");
        }
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

    // `maxBodySize` deliberately does not reach here: the SDK reads and parses
    // this body itself, so the proxy never buffers it and has nothing to cap.
    // The SSE endpoint is therefore bounded by whatever limit the SDK applies,
    // not by the stream endpoint's. Front this with a gateway limit if you need
    // the two to match.
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
  eventStoreMaxEvents,
  host = "::",
  keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT,
  maxBodySize,
  modern = true,
  oauth,
  onClose,
  onConnect,
  onListenSubscriptions,
  onUnhandledRequest,
  port,
  sessionIdleTimeout = DEFAULT_SESSION_IDLE_TIMEOUT,
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
  /**
   * Event store for the streamable HTTP transport's resumability support.
   * Pass `false` to disable resumability entirely (recommended for
   * request/response-only deployments that don't need replay-on-reconnect).
   * Omit to get a fresh, bounded `InMemoryEventStore` per session - see
   * `eventStoreMaxEvents`. Pass an `EventStore` instance to bring your own
   * (e.g. a persistent, cross-process store); it will be shared across all
   * sessions handled by this server.
   */
  eventStore?: EventStoreOption;
  /**
   * Caps how many events the auto-created per-session `InMemoryEventStore`
   * retains (oldest evicted first) before it's overridden by an explicit
   * `eventStore`. Bounds memory for long-lived sessions. Default: 1000.
   */
  eventStoreMaxEvents?: number;
  host?: string;
  keepAliveTimeout?: number;
  /**
   * Caps how many bytes of a request body the stream endpoint buffers,
   * bounding the memory a single request can consume. A request over the cap
   * is answered with `413 Payload Too Large` and the connection is closed.
   * Default: 10485760 (10 MiB). Pass `false` to disable the cap entirely
   * (unbounded buffering - only safe behind a gateway that already limits body
   * size). Does not apply to the SSE endpoint, whose POST bodies are read by
   * the MCP SDK.
   */
  maxBodySize?: MaxBodySizeOption;
  /**
   * Serve protocol revision 2026-07-28 alongside the 2025-era revisions on
   * `streamEndpoint`. Each POST is classified by whether it carries the
   * revision's per-request `_meta` envelope, so both eras share one URL and
   * neither client needs to know the other exists.
   *
   * Pass `false` to serve only 2025-era clients; 2026-07-28 traffic then falls
   * through to the session machinery, which does not recognise it. The leg
   * lives on `streamEndpoint`, so it is also absent when that is `null`.
   * Default: `true`.
   */
  modern?: boolean;
  oauth?: AuthConfig["oauth"];
  /**
   * Called when a server instance is torn down.
   *
   * The unit of "a server" differs by protocol era: a 2025-era connection holds
   * one instance for the life of its session, while 2026-07-28 builds a fresh
   * one per request - so on that leg this fires once per request. Keep it cheap
   * and idempotent. A rejection is logged and does not stop the rest of
   * teardown.
   */
  onClose?: (server: T) => Promise<void>;
  /**
   * Called when a server instance is created. Fires once per session on the
   * 2025-era legs and once per request on the 2026-07-28 leg - see `onClose`.
   */
  onConnect?: (server: T) => Promise<void>;
  /**
   * Acts on the `resourceSubscriptions` of an incoming 2026-07-28
   * `subscriptions/listen`. A proxy uses this to subscribe upstream; without it
   * the filter is honored locally and the client is never told anything
   * changed. See {@link ListenSubscriptionsHandler}.
   */
  onListenSubscriptions?: ListenSubscriptionsHandler;
  onUnhandledRequest?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
  port: number;
  /**
   * How long a stateful stream session survives with no stream attached and no
   * requests before it is closed, in milliseconds. Default: 1800000 (30
   * minutes). Pass `0` to keep every session until its client sends `DELETE`.
   *
   * Ending a session is the client's job, and most 2025-era clients never do
   * it - they close a laptop or lose a network and are simply never heard from
   * again. Each one left behind holds a `Server`, a transport and an event
   * store that goes on buffering notifications it can no longer deliver, for as
   * long as the process runs.
   *
   * A session with a stream attached is never closed however long it has been
   * quiet, so this does not cut off a client parked on the notification stream.
   * What it costs is resumability past the timeout: a client returning later
   * with a `Last-Event-ID` gets a new session instead of its replay.
   */
  sessionIdleTimeout?: number;
  sseEndpoint?: null | string;
  sslCa?: null | string;
  sslCert?: null | string;
  sslKey?: null | string;
  stateless?: boolean;
  streamEndpoint?: null | string;
}): Promise<SSEServer> => {
  const activeSSETransports: Record<string, SSEServerTransport> = {};

  const activeStreamTransports: Record<string, StreamSession<T>> = {};

  const authMiddleware = new AuthenticationMiddleware({ apiKey, oauth });

  // Only built when the stream endpoint exists: 2026-07-28 has no SSE-transport
  // counterpart, so an SSE-only deployment has nowhere to serve it.
  const modernHandler =
    modern && streamEndpoint
      ? createModernLeg({
          createServer,
          onClose,
          onConnect,
          onListenSubscriptions,
        })
      : undefined;

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

    // Determine whether the request targets an MCP protocol endpoint (SSE
    // or HTTP Stream). For those endpoints, onUnhandledRequest MUST NOT run
    // first — some consumers (e.g. fastmcp) use it as a catch-all 404 handler
    // and would otherwise short-circuit the MCP protocol handlers.
    // Use a fixed base because `host` may be "::" (IPv6 any), which is not a
    // valid URL authority. We only need pathname here.
    // A malformed request target (e.g. "//") makes `new URL` throw, which
    // would crash the process from this listener, so reject it with 400.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url || "", "http://localhost");
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const isMcpEndpoint =
      (sseEndpoint && requestUrl.pathname === sseEndpoint) ||
      (streamEndpoint && requestUrl.pathname === streamEndpoint);

    // Let non-MCP routes (e.g. /health, /ready, OAuth metadata) be handled
    // before auth — API key auth protects MCP protocol endpoints, not custom routes.
    if (onUnhandledRequest && !isMcpEndpoint) {
      await onUnhandledRequest(req, res);
      if (res.writableEnded) {
        return;
      }
    }

    // Check authentication for MCP protocol endpoints
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
        eventStoreMaxEvents,
        maxBodySize,
        modernHandler,
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

    res.writeHead(404).end();
  };

  let httpServer: http.Server | https.Server;
  if (sslCa || sslCert || sslKey) {
    const options: https.ServerOptions = {};
    if (sslCa) {
      try {
        options.ca = fs.readFileSync(sslCa);
      } catch (error) {
        throw new Error(
          `Failed to read CA file '${sslCa}': ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    if (sslCert) {
      try {
        options.cert = fs.readFileSync(sslCert);
      } catch (error) {
        throw new Error(
          `Failed to read certificate file '${sslCert}': ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    if (sslKey) {
      try {
        options.key = fs.readFileSync(sslKey);
      } catch (error) {
        throw new Error(
          `Failed to read key file '${sslKey}': ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    httpServer = https.createServer(options, requestListener);
  } else {
    httpServer = http.createServer(requestListener);
  }

  // Keep stateful stream sessions from being torn down when Node closes
  // otherwise-idle HTTP keep-alive sockets after its 5 second default.
  httpServer.keepAliveTimeout = keepAliveTimeout;
  httpServer.headersTimeout = Math.max(
    httpServer.headersTimeout,
    keepAliveTimeout + 1000,
  );

  // Sessions survive the connections that create them, and are meant to be
  // ended by a `DELETE` that most clients never send. Without this sweep, every
  // client that just stops talking leaves its session resident for the life of
  // the process.
  let sweeping = false;

  const sessionReaper =
    sessionIdleTimeout > 0
      ? setInterval(
          () => {
            // A sweep yields on each session it closes, so a large enough
            // backlog can span ticks. Overlapping sweeps would not corrupt
            // anything - `closing` already keeps one session from being closed
            // twice - but they would pile up redundant passes over the map.
            if (sweeping) {
              return;
            }

            sweeping = true;

            void reapIdleSessions(activeStreamTransports, sessionIdleTimeout)
              .catch((error: unknown) => {
                console.error(
                  "[mcp-proxy] error sweeping idle sessions",
                  error,
                );
              })
              .finally(() => {
                sweeping = false;
              });
          },
          Math.min(SESSION_SWEEP_INTERVAL, sessionIdleTimeout),
        )
      : undefined;

  // Reclaiming memory is not a reason to keep a process alive.
  sessionReaper?.unref();

  await new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      resolve(undefined);
    });
  });

  return {
    close: async () => {
      if (sessionReaper) {
        clearInterval(sessionReaper);
      }

      for (const transport of Object.values(activeSSETransports)) {
        await transport.close();
      }

      for (const transport of Object.values(activeStreamTransports)) {
        await transport.transport.close();
      }

      await modernHandler?.close();

      return new Promise((resolve, reject) => {
        // A socket that carried a closed `subscriptions/listen` stream stays
        // counted as in-flight even though the exchange is over, and `close()`
        // waits seconds for it - long enough to eat most of the CLI's
        // graceful-shutdown budget. Anything genuinely still running gets this
        // grace period first; only what outlives it is cut off. Unref'd so it
        // never holds the process open by itself.
        const forceTimer = setTimeout(() => {
          httpServer.closeAllConnections();
        }, FORCE_CLOSE_GRACE_PERIOD);

        forceTimer.unref();

        httpServer.close((error) => {
          clearTimeout(forceTimer);

          if (error) {
            reject(error);

            return;
          }

          resolve();
        });

        // Keep-alive sockets with nothing on them would otherwise hold
        // `close()` open; releasing them costs no in-flight work.
        httpServer.closeIdleConnections();
      });
    },
    notify: modernHandler?.notify ?? NO_MODERN_SUBSCRIBERS,
  };
};
