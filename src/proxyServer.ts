import type {
  RequestOptions,
  ServerCapabilities,
  ServerContext,
} from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";

import { getUpstreamBridge } from "./upstreamNotifications.js";

/**
 * The first revision of the 2026 era. Revisions are date-stamped, so ordering
 * them as strings is both correct and stable for revisions not yet published.
 */
const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Only a positively identified 2026-07-28-or-later connection is treated as
 * modern. An unknown version means "keep forwarding": unsolicited delivery is
 * the 2025-era behavior and the safe default, and suppressing on a maybe would
 * silently drop notifications a client is entitled to.
 */
const isModernEraConnection = (server: Server): boolean => {
  const version = server.getNegotiatedProtocolVersion();

  return version !== undefined && version >= FIRST_MODERN_PROTOCOL_VERSION;
};

/**
 * Wires a downstream `Server` to forward every request it can serve to the
 * upstream `client`.
 *
 * Handlers are registered from `serverCapabilities` rather than blanket-
 * forwarded, so a method the upstream never advertised is answered
 * "method not found" here instead of making a round trip to find out.
 *
 * The 2026-07-28-only methods (`server/discover`, `subscriptions/listen`) are
 * deliberately absent: the serving entry answers those itself from the
 * capabilities and identity this `Server` was constructed with.
 */
export const proxyServer = async ({
  client,
  requestTimeout,
  server,
  serverCapabilities,
}: {
  client: Client;
  requestTimeout?: number;
  server: Server;
  serverCapabilities: ServerCapabilities;
}): Promise<void> => {
  const bridge = getUpstreamBridge({ client, requestTimeout });

  /**
   * Per-request options for a forwarded call.
   *
   * A proxied request is not a fresh request: it inherits the caller's
   * lifetime and its side channels. Without `signal` a downstream abort leaves
   * the upstream call running to completion; without `onprogress` the upstream
   * is never asked for progress at all, so neither era sees any.
   */
  const forwardOptions = (ctx: ServerContext): RequestOptions => {
    const progressToken = ctx.mcpReq._meta?.progressToken;

    return {
      // The upstream progress token is the SDK's own; the downstream one has
      // to be restored on the way back or the client cannot match it up.
      ...(progressToken === undefined
        ? {}
        : {
            onprogress: (progress) => {
              void ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { ...progress, progressToken },
                })
                .catch((error: unknown) => {
                  console.error(
                    "[mcp-proxy] error forwarding progress",
                    error,
                  );
                });
            },
          }),
      signal: ctx.mcpReq.signal,
      ...(requestTimeout ? { timeout: requestTimeout } : {}),
    };
  };

  /**
   * Unsolicited server->client notifications exist only in the 2025 era. A
   * 2026-07-28 connection gets change events from the serving entry's
   * subscription bus (see `startHTTPServer`'s `notify`), and its per-request
   * instance is usually already closed by the time an upstream change arrives -
   * so this forwards only while a 2025-era connection is live, and never lets a
   * send that loses the race reach the process as an unhandled rejection.
   */
  const forward = (send: () => Promise<void>) => {
    if (server.transport === undefined || isModernEraConnection(server)) {
      return;
    }

    send().catch((error) => {
      console.error("[mcp-proxy] error forwarding upstream notification", error);
    });
  };

  const lease = bridge.subscribe({
    loggingMessage: (params) => {
      forward(() =>
        server.notification({ method: "notifications/message", params }),
      );
    },
    promptsListChanged: () => {
      forward(() =>
        server.notification({ method: "notifications/prompts/list_changed" }),
      );
    },
    resourcesListChanged: () => {
      forward(() =>
        server.notification({ method: "notifications/resources/list_changed" }),
      );
    },
    resourceUpdated: (params) => {
      forward(() =>
        server.notification({
          method: "notifications/resources/updated",
          params,
        }),
      );
    },
    toolsListChanged: () => {
      forward(() =>
        server.notification({ method: "notifications/tools/list_changed" }),
      );
    },
  });

  const previousOnClose = server.onclose;

  // Releases this connection's stake in the shared upstream client: its
  // notification sink and any resource subscriptions it still holds.
  server.onclose = () => {
    lease.release();
    previousOnClose?.();
  };

  if (serverCapabilities?.prompts) {
    server.setRequestHandler("prompts/get", async (request, ctx) =>
      client.getPrompt(request.params, forwardOptions(ctx)),
    );

    server.setRequestHandler("prompts/list", async (request, ctx) => {
      return client.listPrompts(request.params, forwardOptions(ctx));
    });
  }

  if (serverCapabilities?.resources) {
    server.setRequestHandler("resources/list", async (request, ctx) => {
      return client.listResources(request.params, forwardOptions(ctx));
    });

    server.setRequestHandler(
      "resources/templates/list",
      async (request, ctx) => {
        return client.listResourceTemplates(
          request.params,
          forwardOptions(ctx),
        );
      },
    );

    server.setRequestHandler("resources/read", async (request, ctx) =>
      client.readResource(request.params, forwardOptions(ctx)),
    );

    if (serverCapabilities.resources.subscribe) {
      // Routed through the bridge because `resources/subscribe` does not exist
      // on a 2026-07-28 upstream - there the same intent is expressed by the
      // `resourceSubscriptions` field of a `subscriptions/listen` filter.
      server.setRequestHandler("resources/subscribe", async (request) => {
        await lease.addResourceSubscription(request.params.uri);

        return {};
      });

      server.setRequestHandler("resources/unsubscribe", async (request) => {
        await lease.removeResourceSubscription(request.params.uri);

        return {};
      });
    }
  }

  if (serverCapabilities?.tools) {
    server.setRequestHandler("tools/call", async (request, ctx) =>
      client.callTool(request.params, forwardOptions(ctx)),
    );

    server.setRequestHandler("tools/list", async (request, ctx) => {
      return client.listTools(request.params, forwardOptions(ctx));
    });
  }

  if (serverCapabilities?.completions) {
    server.setRequestHandler("completion/complete", async (request, ctx) => {
      return client.complete(request.params, forwardOptions(ctx));
    });
  }
};
