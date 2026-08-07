import type { Client } from "@modelcontextprotocol/client";

import { describe, expect, it, vi } from "vitest";

import {
  acquireListenSubscriptions,
  getUpstreamBridge,
} from "./upstreamNotifications.js";

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

  it("does not reopen behind a close that landed mid-backoff", async () => {
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

    // Inert against today's code, because the reopen loop is detached from the
    // mutation queue and `close()` only ever waits on that. Kept because it is
    // the one thing that would notice the loop being serialized behind the
    // queue - which does not deadlock, so nothing else would.
    expect(Date.now() - startedAt).toBeLessThan(250);

    const afterClose = stub.listen.mock.calls.length;

    // The backoff therefore outlives the bridge. Expiring afterwards must not
    // open a stream nobody owns and nothing would ever close.
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

    it(`opens a fresh stream for a later subscriber after a ${reason} close`, async () => {
      const stub = createStubClient({ era: "modern" });
      const bridge = getUpstreamBridge({ client: asClient(stub) });

      bridge.subscribe({ toolsListChanged: vi.fn() });

      await vi.waitFor(() => {
        expect(stub.listen).toHaveBeenCalledTimes(1);
      });

      stub.dropStream(0, reason);

      // Let the close observer run before the next subscriber arrives, so the
      // assertion cannot pass on microtask ordering alone.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Not reopening on this reason is deliberate, but the ended stream must
      // not be left standing in for a live one. `ensureListenStream` would then
      // read the bridge as already listening, so no later connection could open
      // a replacement - an upstream restart would silently end change delivery
      // for every downstream client that only wants `list_changed`.
      bridge.subscribe({ toolsListChanged: vi.fn() });

      await vi.waitFor(() => {
        expect(stub.listen).toHaveBeenCalledTimes(2);
      });
    });
  }

  it("retries a first open that rejects outright", async () => {
    const stub = createStubClient({ era: "modern" });

    stub.failNextListens(1);

    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    // Only a stream that opened and then dropped reaches the retry loop, so an
    // open that rejects has no `closed` observer to start one. A proxy that
    // came up before its upstream would stay deaf until another connection.
    await vi.waitFor(
      () => {
        expect(stub.listen).toHaveBeenCalledTimes(2);
      },
      { timeout: 5000 },
    );
  }, 20000);

  it("refills the reopen budget once attempts stop for a while", async () => {
    // Only `Date`, so the backoff still runs on real timers and the loop takes
    // the same branches it does in production. The clock the bridge reads is
    // not real time though: `vi.waitFor` ticks fake timers as it polls, so the
    // measured delay below runs ahead of the wall clock. That is fine for a
    // threshold test - it makes the reading more deterministic, not less - but
    // the number is not milliseconds elapsed.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });

    try {
      const stub = createStubClient({ era: "modern" });
      const bridge = getUpstreamBridge({ client: asClient(stub) });

      bridge.subscribe({ toolsListChanged: vi.fn() });

      await vi.waitFor(() => {
        expect(stub.listen).toHaveBeenCalledTimes(1);
      });

      // Spend three attempts, so a fourth would wait 250 * 2 ** 3 = 2000ms.
      stub.dropStream(0);
      await vi.waitFor(() => {
        expect(stub.listen).toHaveBeenCalledTimes(2);
      });

      stub.dropStream(1);
      await vi.waitFor(() => {
        expect(stub.listen).toHaveBeenCalledTimes(3);
      });

      stub.dropStream(2);

      // The gap has to land while no stream is open. Jumping the clock over a
      // live stream would make it look like one that survived
      // `LISTEN_STABLE_AFTER`, and that reset - not the refill - would be what
      // hands the budget back, so the test would pass either way.
      await new Promise((resolve) => setTimeout(resolve, 200));

      vi.setSystemTime(Date.now() + 120_000);

      await vi.waitFor(
        () => {
          expect(stub.listen).toHaveBeenCalledTimes(4);
        },
        { timeout: 4000 },
      );

      const droppedAt = Date.now();

      stub.dropStream(3);

      await vi.waitFor(
        () => {
          expect(stub.listen).toHaveBeenCalledTimes(5);
        },
        { timeout: 6000 },
      );

      // Back at the base delay instead of continuing the exponent, which is
      // what proves the budget refilled rather than merely not being spent.
      expect(Date.now() - droppedAt).toBeLessThan(900);
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("does not refill the reopen budget during a drop storm", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    await vi.waitFor(() => {
      expect(stub.listen).toHaveBeenCalledTimes(1);
    });

    stub.dropStream(0);
    await vi.waitFor(() => {
      expect(stub.listen).toHaveBeenCalledTimes(2);
    });

    stub.dropStream(1);
    await vi.waitFor(() => {
      expect(stub.listen).toHaveBeenCalledTimes(3);
    });

    const droppedAt = Date.now();

    stub.dropStream(2);

    await vi.waitFor(
      () => {
        expect(stub.listen).toHaveBeenCalledTimes(4);
      },
      { timeout: 5000 },
    );

    // Third attempt, so `250 * 2 ** 2`. A refill firing inside the storm would
    // put this back at the base delay and the cap would never be reached - the
    // spin it exists to stop. The refill window has to stay long enough that a
    // storm always outruns it.
    expect(Date.now() - droppedAt).toBeGreaterThan(700);
  }, 20000);

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

  it("does not wait out an in-flight upstream call on close", async () => {
    const stub = createStubClient({ era: "modern", listenDelayMs: 5000 });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    bridge.subscribe({ toolsListChanged: vi.fn() });

    // Let the open take the queue before the close lands behind it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();

    await bridge.close();

    // The queue is holding a `listen()` bounded by `requestTimeout` - five
    // minutes by default - against a five second graceful-shutdown budget.
    expect(Date.now() - startedAt).toBeLessThan(2000);

    // Not waiting for the queue is not abandoning it: the teardown still runs
    // behind the returned promise, so the stream the close overtook is torn
    // down too - just after the caller has its shutdown budget back.
    await vi.waitFor(
      () => {
        expect(stub.closes).toEqual([1]);
      },
      { timeout: 8000 },
    );
  }, 20000);

  it("does not hand back a closed bridge", async () => {
    const stub = createStubClient({ era: "modern" });
    const bridge = getUpstreamBridge({ client: asClient(stub) });

    await bridge.close();

    // A closed bridge's `ensureListenStream` no-ops forever, so returning the
    // memoized one would leave the caller silently unable to subscribe.
    expect(getUpstreamBridge({ client: asClient(stub) })).not.toBe(bridge);
  });

  it("releases what it took when a listen filter is only partly accepted", async () => {
    const stub = createStubClient();

    stub.subscribeResource.mockImplementation(async ({ uri }) => {
      if (uri === "file:///denied.txt") {
        throw new Error("upstream refused the subscription");
      }

      return { uri };
    });

    await expect(
      acquireListenSubscriptions({
        client: asClient(stub),
        // The denial goes first, so the two behind it are still queued when it
        // rejects. Releasing on the rejection alone gives back only what had
        // been taken by then, and the rest subscribe into a lease nobody holds.
        uris: [
          "file:///denied.txt",
          "file:///first.txt",
          "file:///second.txt",
        ],
      }),
    ).rejects.toThrow("upstream refused");

    // A hook that throws never hands its caller a release, and the stream the
    // filter belonged to is never served, so no teardown runs either. Anything
    // the upstream did accept is held for good unless it is given back here.
    await vi.waitFor(() => {
      expect(stub.unsubscribeResource).toHaveBeenCalledWith(
        { uri: "file:///first.txt" },
        undefined,
      );

      expect(stub.unsubscribeResource).toHaveBeenCalledWith(
        { uri: "file:///second.txt" },
        undefined,
      );
    });
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
