import type { Client } from "@modelcontextprotocol/client";

import { describe, expect, it, vi } from "vitest";

import { getUpstreamBridge } from "./upstreamNotifications.js";

/**
 * A stand-in for the upstream `Client`. Only the surface the bridge touches is
 * implemented; `getUpstreamBridge` keys off object identity, so each stub gets
 * its own bridge.
 */
const createStubClient = ({
  era = "legacy",
  listenDelayMs = 0,
}: {
  era?: "legacy" | "modern";
  listenDelayMs?: number;
} = {}) => {
  const handlers = new Map<string, (notification: unknown) => void>();
  const closes: number[] = [];
  const drops: ((reason: string) => void)[] = [];

  /** How many of the next `listen()` calls reject instead of opening. */
  let failNextListens = 0;

  const listen = vi.fn(async (filter: unknown) => {
    if (listenDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, listenDelayMs));
    }

    if (failNextListens > 0) {
      failNextListens--;

      throw new Error("transient upstream failure");
    }

    const index = listen.mock.calls.length;

    let settle: (reason: string) => void = () => {};
    const closed = new Promise<string>((resolve) => {
      settle = resolve;
    });

    drops.push(settle);

    return {
      close: async () => {
        closes.push(index);
        settle("local");
      },
      closed,
      honoredFilter: filter,
    };
  });

  const stub = {
    closes,
    /**
     * Ends the nth opened stream. The SDK's own vocabulary: `'remote'` is an
     * unexpected disconnect, `'graceful'` the server ending it deliberately,
     * `'local'` our own `close()`.
     */
    dropStream: (index: number, reason = "remote") => drops[index]?.(reason),
    emit: (method: string, params?: unknown) => {
      handlers.get(method)?.({ method, params });
    },
    /** Makes the next `count` `listen()` calls reject rather than open. */
    failNextListens: (count: number) => {
      failNextListens = count;
    },
    getProtocolEra: () => era,
    getServerCapabilities: () => ({
      resources: { listChanged: true, subscribe: true },
      tools: { listChanged: true },
    }),
    listen,
    setNotificationHandler: (
      method: string,
      handler: (notification: unknown) => void,
    ) => {
      handlers.set(method, handler);
    },
    subscribeResource: vi.fn(async ({ uri }: { uri: string }) => ({ uri })),
    unsubscribeResource: vi.fn(async ({ uri }: { uri: string }) => ({ uri })),
  };

  return stub;
};

const asClient = (stub: ReturnType<typeof createStubClient>) =>
  stub as unknown as Client;

describe("getUpstreamBridge", () => {
  it("returns one bridge per client", () => {
    const stub = createStubClient();

    expect(getUpstreamBridge({ client: asClient(stub) })).toBe(
      getUpstreamBridge({ client: asClient(stub) }),
    );
  });

  it("fans one upstream notification out to every sink", () => {
    const stub = createStubClient();
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const first = vi.fn();
    const second = vi.fn();

    bridge.subscribe({ toolsListChanged: first });
    const second_ = bridge.subscribe({ toolsListChanged: second });

    stub.emit("notifications/tools/list_changed");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The overwrite bug this guards: a second subscriber must not displace the
    // first, and unsubscribing one must not silence the other.
    second_.release();
    stub.emit("notifications/tools/list_changed");

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering after one sink throws", () => {
    const stub = createStubClient();
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const healthy = vi.fn();

    bridge.subscribe({
      toolsListChanged: () => {
        throw new Error("downstream is gone");
      },
    });
    bridge.subscribe({ toolsListChanged: healthy });

    expect(() => stub.emit("notifications/tools/list_changed")).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("opens no listen stream against a 2025-era upstream", async () => {
    const stub = createStubClient({ era: "legacy" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });
    const lease = bridge.subscribe({ toolsListChanged: vi.fn() });

    await lease.addResourceSubscription("file:///a");

    expect(stub.listen).not.toHaveBeenCalled();
    // There, a resource subscription is a real `resources/subscribe` call.
    expect(stub.subscribeResource).toHaveBeenCalledWith(
      { uri: "file:///a" },
      undefined,
    );
  });

  it("opens exactly one listen stream for concurrent subscribers", async () => {
    const stub = createStubClient({ era: "modern", listenDelayMs: 20 });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    // Each would see "no stream yet" if opening were not serialized.
    bridge.subscribe({ toolsListChanged: vi.fn() });
    bridge.subscribe({ toolsListChanged: vi.fn() });
    bridge.subscribe({ toolsListChanged: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stub.listen).toHaveBeenCalledTimes(1);
  });

  it("replaces the stream when a resource subscription changes the filter", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const lease = bridge.subscribe({ resourceUpdated: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await lease.addResourceSubscription("file:///a");

    expect(stub.listen).toHaveBeenCalledTimes(2);
    expect(stub.listen.mock.calls[1][0]).toMatchObject({
      resourceSubscriptions: ["file:///a"],
    });
    // The superseded stream is closed, not leaked.
    expect(stub.closes).toEqual([1]);

    // `resources/subscribe` does not exist on a 2026-07-28 upstream.
    expect(stub.subscribeResource).not.toHaveBeenCalled();
  });

  it("keeps a URI subscribed while another connection still wants it", async () => {
    const stub = createStubClient({ era: "legacy" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const a = bridge.subscribe({ resourceUpdated: vi.fn() });
    const b = bridge.subscribe({ resourceUpdated: vi.fn() });

    await a.addResourceSubscription("file:///shared");
    await b.addResourceSubscription("file:///shared");

    // One upstream subscribe for two downstream subscribers.
    expect(stub.subscribeResource).toHaveBeenCalledTimes(1);

    await b.removeResourceSubscription("file:///shared");

    // B leaving must not cancel A's subscription upstream.
    expect(stub.unsubscribeResource).not.toHaveBeenCalled();

    await a.removeResourceSubscription("file:///shared");

    expect(stub.unsubscribeResource).toHaveBeenCalledTimes(1);
  });

  it("releases a disconnecting connection's subscriptions", async () => {
    const stub = createStubClient({ era: "legacy" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const lease = bridge.subscribe({ resourceUpdated: vi.fn() });

    await lease.addResourceSubscription("file:///a");
    await lease.addResourceSubscription("file:///b");

    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      stub.unsubscribeResource.mock.calls.map(([params]) => params.uri).sort(),
    ).toEqual(["file:///a", "file:///b"]);
  });

  it("does not record a subscription the upstream rejected", async () => {
    const stub = createStubClient({ era: "legacy" });

    stub.subscribeResource.mockRejectedValueOnce(new Error("nope"));

    const bridge = getUpstreamBridge({ client: asClient(stub) });
    const lease = bridge.subscribe({ resourceUpdated: vi.fn() });

    await expect(
      lease.addResourceSubscription("file:///a"),
    ).rejects.toThrow("nope");

    // A later unsubscribe must not be sent for a URI never subscribed.
    await lease.removeResourceSubscription("file:///a");

    expect(stub.unsubscribeResource).not.toHaveBeenCalled();
  });

  it("does not let a release race a reconnect into dropping the URI", async () => {
    const stub = createStubClient({ era: "legacy" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const leaving = bridge.subscribe({ resourceUpdated: vi.fn() });

    await leaving.addResourceSubscription("file:///x");

    const arriving = bridge.subscribe({ resourceUpdated: vi.fn() });

    // A disconnect and a reconnect claiming the same URI, with no await
    // between: the refcount change and the upstream call it implies have to be
    // one step, or the late unsubscribe cancels what the new lease just took.
    leaving.release();
    await arriving.addResourceSubscription("file:///x");

    await new Promise((resolve) => setTimeout(resolve, 20));

    const subscribes = stub.subscribeResource.mock.calls.length;
    const unsubscribes = stub.unsubscribeResource.mock.calls.length;

    // Whatever the interleaving, the URI must end up subscribed for `arriving`.
    expect(subscribes - unsubscribes).toBe(1);
  });

  it("reopens the listen stream after an unexpected drop", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    const lease = bridge.subscribe({ resourceUpdated: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await lease.addResourceSubscription("file:///a");

    const beforeDrop = stub.listen.mock.calls.length;

    // The SDK does not re-listen on its own; without the `closed` observer the
    // bridge still believes the stream is live and change delivery stops for
    // good.
    stub.dropStream(beforeDrop - 1);

    await vi.waitFor(() => {
      expect(stub.listen.mock.calls.length).toBe(beforeDrop + 1);
    });

    // The replacement carries the subscriptions the dropped one held.
    expect(stub.listen.mock.calls[beforeDrop][0]).toMatchObject({
      resourceSubscriptions: ["file:///a"],
    });
  });

  it("keeps spending the budget after a reopen attempt that itself fails", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    await vi.waitFor(() => {
      expect(stub.listen).toHaveBeenCalledTimes(1);
    });

    // The reopen rejects outright rather than opening a stream that later
    // drops, so there is no next `closed` to hang the following attempt off.
    // Retrying only from a successful open would stop the loop dead here and
    // leave change delivery off until some unrelated `subscribe()` retried.
    stub.failNextListens(1);

    stub.dropStream(0);

    await vi.waitFor(
      () => {
        expect(stub.listen).toHaveBeenCalledTimes(3);
      },
      { timeout: 5000 },
    );
  }, 20000);

  it("does not wait out a pending backoff on close", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    await vi.waitFor(() => {
      expect(stub.listen).toHaveBeenCalledTimes(1);
    });

    stub.failNextListens(4);

    stub.dropStream(0);

    // Land inside a backoff window, with most of it still to run.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const startedAt = Date.now();

    await bridge.close();

    expect(Date.now() - startedAt).toBeLessThan(250);

    const afterClose = stub.listen.mock.calls.length;

    // And the backoff does not come back to life behind the close.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(stub.listen.mock.calls.length).toBe(afterClose);
  }, 20000);

  for (const reason of ["local", "graceful"] as const) {
    it(`does not reopen after a ${reason} close`, async () => {
      const stub = createStubClient({ era: "modern" });
      const bridge = getUpstreamBridge({ client: asClient(stub) });

      bridge.subscribe({ toolsListChanged: vi.fn() });

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Neither is an unexpected disconnect: `local` is our own close and
      // `graceful` the server ending the subscription deliberately. Chasing
      // either means reconnecting to something that is going away on purpose.
      stub.dropStream(0, reason);

      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(stub.listen).toHaveBeenCalledTimes(1);
    });
  }

  it("gives up rather than spinning on a stream that keeps dropping", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    // An upstream that accepts a listen and drops it immediately. Without a cap
    // and a backoff this spins as fast as the round trip allows.
    for (let round = 0; round < 12; round++) {
      const opened = stub.listen.mock.calls.length;

      if (opened > 0) {
        stub.dropStream(opened - 1);
      }

      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    expect(stub.listen.mock.calls.length).toBeLessThanOrEqual(4);
  }, 20000);

  it("does not hand back a closed bridge", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    await bridge.close();

    // A closed bridge's `ensureListenStream` no-ops forever, so returning the
    // memoized one would leave the caller silently unable to subscribe.
    expect(getUpstreamBridge({ client: asClient(stub) })).not.toBe(bridge);
  });

  it("tears the stream down on close", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await bridge.close();

    expect(stub.closes).toEqual([1]);
  });
});
