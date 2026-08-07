import type {
  LoggingMessageNotificationParams,
  ResourceUpdatedNotificationParams,
} from "@modelcontextprotocol/client";

import { Client } from "@modelcontextprotocol/client";

export type UpstreamBridge = {
  close: () => Promise<void>;
  subscribe: (sink: UpstreamNotificationSink) => UpstreamLease;
};

/**
 * One downstream connection's stake in the shared upstream connection.
 *
 * Resource subscriptions are owned per lease rather than globally: the proxy
 * multiplexes many downstream connections onto one upstream client, so an
 * unsubscribe from one connection must not cancel a subscription another
 * connection still wants, and a connection that goes away must not leave its
 * URIs subscribed forever.
 */
export type UpstreamLease = {
  addResourceSubscription: (uri: string) => Promise<void>;
  /** Drops this lease's sink and every resource subscription it still holds. */
  release: () => void;
  removeResourceSubscription: (uri: string) => Promise<void>;
};

/**
 * One downstream consumer of the upstream server's notifications.
 *
 * Every field is optional so a sink can take only what its era can deliver:
 * `loggingMessage` has no 2026-07-28 counterpart (log level is per-request
 * there, and a server MUST NOT emit `notifications/message` for a request that
 * did not ask for it), so modern sinks leave it unset.
 */
export type UpstreamNotificationSink = {
  loggingMessage?: (params: LoggingMessageNotificationParams) => void;
  promptsListChanged?: () => void;
  resourcesListChanged?: () => void;
  resourceUpdated?: (params: ResourceUpdatedNotificationParams) => void;
  toolsListChanged?: () => void;
};

/**
 * One bridge per upstream `Client`. `proxyServer` is called once per downstream
 * connection but shares a single upstream client, and `setNotificationHandler`
 * is last-writer-wins - registering per connection would leave only the most
 * recent one receiving anything. The bridge registers once and fans out.
 */
const bridges = new WeakMap<Client, UpstreamBridge>();

/**
 * Reopen bounds for a dropped `subscriptions/listen` stream. An upstream that
 * accepts a listen and drops it immediately would otherwise spin as fast as the
 * round trip allows - measured at tens of thousands of attempts per second.
 */
const LISTEN_REOPEN_BASE_DELAY = 250;
const MAX_LISTEN_REOPEN_ATTEMPTS = 6;

/**
 * How long a stream must survive to count as healthy. Resetting the attempt
 * budget on every successful open would make the cap unreachable for the very
 * failure it exists for - an upstream that accepts a listen and drops it.
 */
const LISTEN_STABLE_AFTER = 30_000;

/**
 * How long `close()` waits for the mutation queue to drain before giving up on
 * it.
 *
 * Queue items run in series, so the wait is their sum, and several of them are
 * upstream round trips: a `listen()` waiting on its ack and
 * `resources/(un)subscribe` are bounded by `requestTimeout` - five minutes by
 * default - while `McpSubscription.close()` sends `notifications/cancelled`
 * through the transport under no timeout at all. The CLI's entire
 * graceful-shutdown budget is five seconds, so waiting the queue out turns a
 * clean exit into `process.exit(1)`. Whatever is still in flight is settled by
 * the `client.close()` that follows, which tears the transport down under it.
 *
 * Matches `FORCE_CLOSE_GRACE_PERIOD` in `startHTTPServer`. Both are literals
 * while `--gracefulShutdownTimeout` is user-settable, so a budget below a
 * couple of seconds is already spoken for before either of them yields.
 */
const CLOSE_TEARDOWN_TIMEOUT = 1_000;

/**
 * Change notifications reach a 2025-era client unsolicited, but a 2026-07-28
 * server sends them only on a `subscriptions/listen` stream the client opened.
 * The SDK dispatches both onto the same `setNotificationHandler` registrations,
 * so the only era-dependent part is opening (and re-opening) that stream.
 */
const createBridge = ({
  client,
  requestTimeout,
}: {
  client: Client;
  requestTimeout?: number;
}): UpstreamBridge => {
  const sinks = new Set<UpstreamNotificationSink>();

  const fanOut = <K extends keyof UpstreamNotificationSink>(
    key: K,
    invoke: (sink: UpstreamNotificationSink) => void,
  ) => {
    for (const sink of sinks) {
      if (!sink[key]) {
        continue;
      }

      try {
        invoke(sink);
      } catch (error) {
        // One failing downstream connection must not stop delivery to the rest.
        console.error(`[mcp-proxy] error forwarding ${key}`, error);
      }
    }
  };

  client.setNotificationHandler("notifications/message", async (n) => {
    fanOut("loggingMessage", (sink) => sink.loggingMessage?.(n.params));
  });

  client.setNotificationHandler(
    "notifications/resources/updated",
    async (n) => {
      fanOut("resourceUpdated", (sink) => sink.resourceUpdated?.(n.params));
    },
  );

  client.setNotificationHandler(
    "notifications/tools/list_changed",
    async () => {
      fanOut("toolsListChanged", (sink) => sink.toolsListChanged?.());
    },
  );

  client.setNotificationHandler(
    "notifications/prompts/list_changed",
    async () => {
      fanOut("promptsListChanged", (sink) => sink.promptsListChanged?.());
    },
  );

  client.setNotificationHandler(
    "notifications/resources/list_changed",
    async () => {
      fanOut("resourcesListChanged", (sink) => sink.resourcesListChanged?.());
    },
  );

  const isModern = () => client.getProtocolEra() === "modern";

  const timeout = requestTimeout ? { timeout: requestTimeout } : undefined;

  /** URI -> how many leases currently want it. */
  const refcounts = new Map<string, number>();

  let closed = false;
  let reopenAttempts = 0;
  let subscription: Awaited<ReturnType<Client["listen"]>> | undefined;

  /** Settles a reopen backoff early; set only while one is pending. */
  let cancelReopenDelay: (() => void) | undefined;

  /**
   * Opening a stream is not atomic, so concurrent callers - several downstream
   * connections subscribing at once, or a subscribe racing a `resources/
   * subscribe` - would each see no stream and open their own, leaking all but
   * the last. Every mutation is queued behind this instead.
   */
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);

    return queue;
  };

  const delayReopen = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelReopenDelay = undefined;

        resolve();
      }, ms);

      // Unref'd so a pending backoff never holds the process open by itself. A
      // shutdown landing inside the window would otherwise keep the event loop
      // alive past the CLI's graceful-shutdown budget and exit non-zero.
      timer.unref();

      cancelReopenDelay = () => {
        clearTimeout(timer);

        cancelReopenDelay = undefined;

        resolve();
      };
    });

  /**
   * The listen filter is fixed at open time, so changing the subscribed set
   * means replacing the stream. Subscriptions are rare enough that the churn is
   * cheaper than tracking a second stream per URI.
   */
  const reopenListenStream = async () => {
    if (closed) {
      return;
    }

    const capabilities = client.getServerCapabilities();

    const previous = subscription;

    const opened = await client.listen(
      {
        promptsListChanged: Boolean(capabilities?.prompts?.listChanged),
        resourcesListChanged: Boolean(capabilities?.resources?.listChanged),
        resourceSubscriptions: [...refcounts.keys()],
        toolsListChanged: Boolean(capabilities?.tools?.listChanged),
      },
      timeout,
    );

    subscription = opened;

    const openedAt = Date.now();

    // Two separate questions, and conflating them wedges the bridge: whether
    // this stream is still live, and whether to chase a replacement.
    //
    // A terminated stream is not live whatever ended it, so `subscription` is
    // cleared whenever this stream is still the one holding it. Leaving it set
    // for the reasons we deliberately do not reopen on would make
    // `ensureListenStream` read a dead stream as a live one, so no later
    // `subscribe()` could open a replacement - that is every new downstream
    // connection, silently, until something reopens by another route
    // (`subscribeUpstream`/`unsubscribeUpstream` do, unconditionally, so a
    // deployment that changes resource subscriptions recovers on its own and
    // one that only wants `list_changed` never does).
    //
    // Only `'remote'` is an unexpected disconnect worth reopening: `'local'` is
    // our own `close()` and `'graceful'` is the server ending the subscription
    // deliberately by answering the listen request, which the SDK's own servers
    // do on shutdown. Chasing either means reconnecting to a peer that is going
    // away on purpose; a later `subscribe()` opens a fresh stream instead.
    void opened.closed
      .then(async (reason) => {
        // A newer stream already replaced this one, and owns `subscription`.
        if (closed || subscription !== opened) {
          return;
        }

        subscription = undefined;

        if (reason !== "remote") {
          if (reason === "graceful") {
            console.error(
              "[mcp-proxy] upstream ended the subscriptions/listen stream; change notifications are off until a new downstream connection or a resource-subscription change opens another",
            );
          }

          return;
        }

        if (Date.now() - openedAt >= LISTEN_STABLE_AFTER) {
          reopenAttempts = 0;
        }

        await reopenUntilLive();
      })
      .catch((error: unknown) => {
        console.error(
          "[mcp-proxy] could not reopen upstream subscriptions/listen stream",
          error,
        );
      });

    // Closed only once its replacement is live, so a change published during
    // the swap still lands on an open stream.
    await previous?.close();
  };

  const ensureListenStream = () =>
    enqueue(async () => {
      if (!isModern() || subscription) {
        return;
      }

      await reopenListenStream();
    });

  /**
   * Spends the reopen budget until a stream is live again.
   *
   * Looping here rather than scheduling one attempt: the attempt itself can
   * fail - a `listen()` that rejects outright, not only a stream that opened and
   * then dropped - and hanging the next attempt off the next stream's `closed`
   * would end the retry there, because there is no next stream. One transient
   * failure would then leave the budget unspent and change delivery dead until
   * some unrelated `subscribe()` happened to try again.
   */
  const reopenUntilLive = async () => {
    while (!closed && reopenAttempts < MAX_LISTEN_REOPEN_ATTEMPTS) {
      // An upstream that accepts a listen and drops it immediately would
      // otherwise spin as fast as the round trip allows.
      const delay = LISTEN_REOPEN_BASE_DELAY * 2 ** reopenAttempts;

      reopenAttempts++;

      console.error(
        `[mcp-proxy] reopening upstream subscriptions/listen stream in ${delay}ms (attempt ${reopenAttempts}/${MAX_LISTEN_REOPEN_ATTEMPTS})`,
      );

      await delayReopen(delay);

      if (closed) {
        return;
      }

      try {
        await ensureListenStream();

        // Live again - the new stream's own observer owns what happens next.
        return;
      } catch (error) {
        console.error(
          "[mcp-proxy] could not reopen upstream subscriptions/listen stream",
          error,
        );
      }
    }

    if (!closed) {
      console.error(
        `[mcp-proxy] gave up reopening the upstream subscriptions/listen stream after ${reopenAttempts} attempts; change notifications are off until a new downstream connection retries`,
      );
    }
  };

  /**
   * `resources/subscribe` does not exist on a 2026-07-28 upstream; there the
   * same intent is the `resourceSubscriptions` field of the listen filter.
   *
   * Both of these already run inside the queue, so they call
   * `reopenListenStream` directly - enqueuing again would deadlock on it.
   */
  const subscribeUpstream = async (uri: string) => {
    if (isModern()) {
      await reopenListenStream();

      return;
    }

    await client.subscribeResource({ uri }, timeout);
  };

  const unsubscribeUpstream = async (uri: string) => {
    if (isModern()) {
      await reopenListenStream();

      return;
    }

    await client.unsubscribeResource({ uri }, timeout);
  };

  return {
    close: async () => {
      closed = true;
      sinks.clear();
      refcounts.clear();

      // A pending backoff is unref'd and already gives up once `closed` is set,
      // so this only stops `close()` from returning while one is still counting
      // down behind it.
      cancelReopenDelay?.();

      // Otherwise a later `getUpstreamBridge(client)` hands back this closed
      // bridge, whose `ensureListenStream` no-ops - silently unsubscribable.
      bridges.delete(client);

      // Queued so an in-flight open finishes first and its stream is the one
      // torn down, rather than being left behind by a close that ran past it -
      // but only waited on for as long as that is cheap. Past the deadline the
      // queue keeps draining behind the returned promise, so the stream is
      // still torn down and any queued lease work still runs; `close()` just
      // stops holding the caller's shutdown budget open for it.
      const drained = enqueue(async () => {
        await subscription?.close();
        subscription = undefined;
      }).catch((error: unknown) => {
        console.error(
          "[mcp-proxy] error tearing down the upstream subscriptions/listen stream",
          error,
        );
      });

      await Promise.race([
        drained,
        new Promise<void>((resolve) => {
          // Unref'd so the deadline never keeps the process alive on its own.
          // It only has to fire while something else already does: a queue that
          // has not drained means an upstream round trip is still in flight.
          setTimeout(resolve, CLOSE_TEARDOWN_TIMEOUT).unref();
        }),
      ]);
    },
    subscribe: (sink) => {
      sinks.add(sink);

      // A modern upstream stays silent until a stream is open, so the first
      // sink is what opens it. Failure here must not fail the connection the
      // sink belongs to - notifications degrade, requests still work.
      ensureListenStream().catch((error: unknown) => {
        console.error(
          "[mcp-proxy] could not open upstream subscriptions/listen stream",
          error,
        );
      });

      const owned = new Set<string>();

      /**
       * Queued so the refcount change and the upstream call it implies are one
       * step. Otherwise a connection releasing a URI can decrement to zero,
       * another connection can claim it back before the unsubscribe is sent,
       * and the late unsubscribe cancels a subscription that is wanted again.
       */
      const removeResourceSubscription = (uri: string) =>
        enqueue(async () => {
          if (!owned.delete(uri)) {
            return;
          }

          const remaining = (refcounts.get(uri) ?? 1) - 1;

          if (remaining > 0) {
            // Another downstream connection still wants it.
            refcounts.set(uri, remaining);

            return;
          }

          refcounts.delete(uri);

          await unsubscribeUpstream(uri);
        });

      return {
        addResourceSubscription: (uri) =>
          enqueue(async () => {
            if (owned.has(uri)) {
              return;
            }

            owned.add(uri);

            const existing = refcounts.get(uri) ?? 0;

            refcounts.set(uri, existing + 1);

            if (existing > 0) {
              // Already subscribed upstream on another lease's behalf.
              return;
            }

            try {
              await subscribeUpstream(uri);
            } catch (error) {
              // Roll back, so a later unsubscribe cannot be sent for a URI the
              // upstream never accepted.
              owned.delete(uri);
              refcounts.delete(uri);

              throw error;
            }
          }),
        release: () => {
          sinks.delete(sink);

          for (const uri of [...owned]) {
            removeResourceSubscription(uri).catch((error: unknown) => {
              console.error(
                `[mcp-proxy] error releasing upstream subscription for ${uri}`,
                error,
              );
            });
          }
        },
        removeResourceSubscription,
      };
    },
  };
};

export const getUpstreamBridge = ({
  client,
  requestTimeout,
}: {
  client: Client;
  /**
   * Only the first call for a given client establishes this; the bridge is
   * shared, so later callers inherit whatever timeout opened it.
   */
  requestTimeout?: number;
}): UpstreamBridge => {
  const existing = bridges.get(client);

  if (existing) {
    return existing;
  }

  const bridge = createBridge({ client, requestTimeout });

  bridges.set(client, bridge);

  return bridge;
};
