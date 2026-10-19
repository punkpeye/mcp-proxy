import type { JSONRPCMessage } from "@modelcontextprotocol/server";

import { describe, expect, it, vi } from "vitest";

import { InMemoryEventStore } from "./InMemoryEventStore.js";

describe("InMemoryEventStore", () => {
  it("stores events and replays them after a specific event ID", async () => {
    const store = new InMemoryEventStore();
    const streamId = "test-stream-123";

    // Create test messages
    const messages: JSONRPCMessage[] = [
      { id: 1, jsonrpc: "2.0", method: "initialize" },
      { id: 2, jsonrpc: "2.0", method: "tools/list" },
      { id: 3, jsonrpc: "2.0", method: "tools/call", params: { name: "test" } },
      { id: 3, jsonrpc: "2.0", result: { success: true } },
      { id: 4, jsonrpc: "2.0", method: "shutdown" },
    ];

    // Store all events and keep track of event IDs
    // Add small delays to ensure different timestamps for proper ordering
    const eventIds: string[] = [];
    for (const message of messages) {
      const eventId = await store.storeEvent(streamId, message);
      expect(eventId).toContain(streamId);
      eventIds.push(eventId);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // Test replaying events after the second event
    const replayedEvents: Array<{ eventId: string; message: JSONRPCMessage }> =
      [];
    const sendMock = vi.fn(async (eventId: string, message: JSONRPCMessage) => {
      replayedEvents.push({ eventId, message });
    });

    const returnedStreamId = await store.replayEventsAfter(
      eventIds[1], // Replay after the second event
      { send: sendMock },
    );

    // Verify the correct stream ID was returned
    expect(returnedStreamId).toBe(streamId);

    // Verify that events 3, 4, and 5 were replayed (after event 2)
    expect(replayedEvents).toHaveLength(3);
    expect(sendMock).toHaveBeenCalledTimes(3);

    // Verify the replayed messages are correct and in order
    expect(replayedEvents[0].message).toEqual(messages[2]);
    expect(replayedEvents[1].message).toEqual(messages[3]);
    expect(replayedEvents[2].message).toEqual(messages[4]);

    // Verify event IDs are preserved
    expect(replayedEvents[0].eventId).toBe(eventIds[2]);
    expect(replayedEvents[1].eventId).toBe(eventIds[3]);
    expect(replayedEvents[2].eventId).toBe(eventIds[4]);
  });

  it("replays the standalone GET stream whose ID begins with an underscore", async () => {
    const store = new InMemoryEventStore();
    const streamId = "_GET_stream";
    const firstMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const secondMessage: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/resources/list_changed",
    };

    const firstEventId = await store.storeEvent(streamId, firstMessage);
    const secondEventId = await store.storeEvent(streamId, secondMessage);
    const replayedEvents: Array<{
      eventId: string;
      message: JSONRPCMessage;
    }> = [];

    const returnedStreamId = await store.replayEventsAfter(firstEventId, {
      send: async (eventId, message) => {
        replayedEvents.push({ eventId, message });
      },
    });

    expect(returnedStreamId).toBe(streamId);
    expect(replayedEvents).toEqual([
      { eventId: secondEventId, message: secondMessage },
    ]);
    expect(await store.getStreamIdForEventId(firstEventId)).toBe(streamId);
  });

  it("isolates events by stream ID and only replays events from the same stream", async () => {
    const store = new InMemoryEventStore();
    const streamId1 = "stream-alpha";
    const streamId2 = "stream-beta";

    // Create messages for two different streams
    const stream1Messages: JSONRPCMessage[] = [
      { id: 1, jsonrpc: "2.0", method: "stream1.init" },
      { id: 2, jsonrpc: "2.0", method: "stream1.process" },
      { id: 3, jsonrpc: "2.0", method: "stream1.complete" },
    ];

    const stream2Messages: JSONRPCMessage[] = [
      { id: 10, jsonrpc: "2.0", method: "stream2.init" },
      { id: 20, jsonrpc: "2.0", method: "stream2.process" },
      { id: 30, jsonrpc: "2.0", method: "stream2.complete" },
    ];

    // Interleave storing events from both streams with small delays
    const stream1EventIds: string[] = [];
    const stream2EventIds: string[] = [];

    // Store first event from each stream
    stream1EventIds.push(await store.storeEvent(streamId1, stream1Messages[0]));
    await new Promise((resolve) => setTimeout(resolve, 1));
    stream2EventIds.push(await store.storeEvent(streamId2, stream2Messages[0]));
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Store second event from each stream
    stream1EventIds.push(await store.storeEvent(streamId1, stream1Messages[1]));
    await new Promise((resolve) => setTimeout(resolve, 1));
    stream2EventIds.push(await store.storeEvent(streamId2, stream2Messages[1]));
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Store third event from each stream
    stream1EventIds.push(await store.storeEvent(streamId1, stream1Messages[2]));
    await new Promise((resolve) => setTimeout(resolve, 1));
    stream2EventIds.push(await store.storeEvent(streamId2, stream2Messages[2]));

    // Replay events from stream 1 after its first event
    const stream1ReplayedEvents: Array<{
      eventId: string;
      message: JSONRPCMessage;
    }> = [];
    const stream1SendMock = vi.fn(
      async (eventId: string, message: JSONRPCMessage) => {
        stream1ReplayedEvents.push({ eventId, message });
      },
    );

    const returnedStreamId1 = await store.replayEventsAfter(
      stream1EventIds[0],
      { send: stream1SendMock },
    );

    // Verify only stream 1 events were replayed
    expect(returnedStreamId1).toBe(streamId1);
    expect(stream1ReplayedEvents).toHaveLength(2);
    expect(stream1ReplayedEvents[0].message).toEqual(stream1Messages[1]);
    expect(stream1ReplayedEvents[1].message).toEqual(stream1Messages[2]);

    // Verify no stream 2 events were included
    for (const event of stream1ReplayedEvents) {
      expect(event.eventId).toContain(streamId1);
      expect(event.eventId).not.toContain(streamId2);
    }

    // Now replay events from stream 2 after its first event
    const stream2ReplayedEvents: Array<{
      eventId: string;
      message: JSONRPCMessage;
    }> = [];
    const stream2SendMock = vi.fn(
      async (eventId: string, message: JSONRPCMessage) => {
        stream2ReplayedEvents.push({ eventId, message });
      },
    );

    const returnedStreamId2 = await store.replayEventsAfter(
      stream2EventIds[0],
      { send: stream2SendMock },
    );

    // Verify only stream 2 events were replayed
    expect(returnedStreamId2).toBe(streamId2);
    expect(stream2ReplayedEvents).toHaveLength(2);
    expect(stream2ReplayedEvents[0].message).toEqual(stream2Messages[1]);
    expect(stream2ReplayedEvents[1].message).toEqual(stream2Messages[2]);

    // Verify no stream 1 events were included
    for (const event of stream2ReplayedEvents) {
      expect(event.eventId).toContain(streamId2);
      expect(event.eventId).not.toContain(streamId1);
    }

    // Test edge case: replay with non-existent event ID returns empty string
    const invalidResult = await store.replayEventsAfter(
      "non-existent-event-id",
      { send: vi.fn() },
    );
    expect(invalidResult).toBe("");

    // Test edge case: replay with empty event ID returns empty string
    const emptyResult = await store.replayEventsAfter("", { send: vi.fn() });
    expect(emptyResult).toBe("");
  });

  it("keeps deterministic ordering even when events share the same timestamp", async () => {
    const store = new InMemoryEventStore();
    const streamId = "deterministic-stream";

    const messages: JSONRPCMessage[] = [
      { id: 1, jsonrpc: "2.0", method: "step/one" },
      { id: 2, jsonrpc: "2.0", method: "step/two" },
      { id: 3, jsonrpc: "2.0", method: "step/three" },
      { id: 4, jsonrpc: "2.0", method: "step/four" },
    ];

    const fixedTimestamp = 1_730_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedTimestamp);

    const eventIds: string[] = [];
    try {
      for (const message of messages) {
        eventIds.push(await store.storeEvent(streamId, message));
      }
    } finally {
      nowSpy.mockRestore();
    }

    // Ensure IDs already arrive sorted since we stored sequentially
    expect(eventIds).toEqual([...eventIds].sort());

    const parts = eventIds.map((eventId) => eventId.split("_"));

    const timestampParts = parts.map(([, timestamp]) => timestamp);
    expect(timestampParts).toEqual(
      Array(messages.length).fill(fixedTimestamp.toString()),
    );

    const counterSuffixes = parts.map(([, , counter]) => counter);
    expect(counterSuffixes).toEqual(
      messages.map((_, index) => index.toString(36).padStart(4, "0")),
    );

    // Random parts should be 3 base36 characters each (due to substring(2, 5))
    const randomParts = parts.map(([, , , random]) => random);
    for (const random of randomParts) {
      expect(random).toMatch(/^[0-9a-z]{3}$/);
    }

    // Replay after the first event and ensure the remainder flow in order
    const replayedMessages: JSONRPCMessage[] = [];
    const returnedStreamId = await store.replayEventsAfter(eventIds[0], {
      send: async (_eventId: string, message: JSONRPCMessage) => {
        replayedMessages.push(message);
      },
    });

    expect(returnedStreamId).toBe(streamId);
    expect(replayedMessages).toEqual(messages.slice(1));

    // Now allow timestamp to advance to ensure counter resets
    const nextTimestamp = fixedTimestamp + 1;
    const secondSpy = vi.spyOn(Date, "now").mockReturnValue(nextTimestamp);
    try {
      const nextId = await store.storeEvent(streamId, {
        id: 5,
        jsonrpc: "2.0",
        method: "step/five",
      });
      const [, , counter, random] = nextId.split("_");
      expect(counter).toBe("0000");
      expect(random).toMatch(/^[0-9a-z]{3}$/);
    } finally {
      secondSpy.mockRestore();
    }
  });

  it("evicts the oldest events once maxEvents is exceeded", async () => {
    const store = new InMemoryEventStore({ maxEvents: 3 });
    const streamId = "bounded-stream";

    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      eventIds.push(
        await store.storeEvent(streamId, {
          id: i,
          jsonrpc: "2.0",
          method: `step/${i}`,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // Only the 3 most recently stored events survive.
    expect(store.size).toBe(3);

    // The two oldest events were evicted, so resuming from them is no
    // longer possible - the caller falls back to a fresh stream.
    for (const evictedId of eventIds.slice(0, 2)) {
      const result = await store.replayEventsAfter(evictedId, {
        send: vi.fn(),
      });
      expect(result).toBe("");
    }

    // Resuming from a surviving event still replays what came after it.
    const replayed: JSONRPCMessage[] = [];
    const returnedStreamId = await store.replayEventsAfter(eventIds[2], {
      send: async (_eventId, message) => {
        replayed.push(message);
      },
    });
    expect(returnedStreamId).toBe(streamId);
    expect(replayed).toHaveLength(2);
  });

  it.each(["replay-stream", "other-stream"])(
    "does not skip retained events when %s evicts the cursor during replay",
    async (writerStreamId) => {
      const store = new InMemoryEventStore({ maxEvents: 3 });
      const streamId = "replay-stream";
      const messages: JSONRPCMessage[] = [1, 2, 3, 4].map((id) => ({
        id,
        jsonrpc: "2.0",
        method: "step",
      }));
      const eventIds: string[] = [];
      for (const message of messages.slice(0, 3)) {
        eventIds.push(await store.storeEvent(streamId, message));
      }
      const replayed: JSONRPCMessage[] = [];
      const returnedStreamId = await store.replayEventsAfter(eventIds[0], {
        send: async (eventId, message) => {
          replayed.push(message);
          if (eventId === eventIds[1]) {
            await store.storeEvent(writerStreamId, messages[3]);
          }
        },
      });

      expect(returnedStreamId).toBe(streamId);
      expect(replayed).toEqual(
        writerStreamId === streamId ? messages.slice(1) : messages.slice(1, 3),
      );
      expect(await store.getStreamIdForEventId(eventIds[2])).toBe(streamId);
      expect(store.size).toBe(3);
    },
  );

  it("continues replay when eviction removes and recreates the stream index", async () => {
    const store = new InMemoryEventStore({ maxEvents: 3 });
    const streamId = "replay-stream";
    const messages: JSONRPCMessage[] = [1, 2, 3, 4].map((id) => ({
      id,
      jsonrpc: "2.0",
      method: "step",
    }));
    const eventIds: string[] = [];
    for (const message of messages.slice(0, 3)) {
      eventIds.push(await store.storeEvent(streamId, message));
    }
    const replayed: JSONRPCMessage[] = [];
    const returnedStreamId = await store.replayEventsAfter(eventIds[0], {
      send: async (eventId, message) => {
        replayed.push(message);
        if (eventId === eventIds[1]) {
          for (const otherMessage of messages.slice(0, 3)) {
            await store.storeEvent("other-stream", otherMessage);
          }
          await store.storeEvent(streamId, messages[3]);
        }
      },
    });

    expect(returnedStreamId).toBe(streamId);
    expect(replayed).toEqual([messages[1], messages[3]]);
    expect(await store.getStreamIdForEventId(eventIds[2])).toBeUndefined();
    expect(store.size).toBe(3);
  });

  it("caps total retained events across all streams, not per stream", async () => {
    const store = new InMemoryEventStore({ maxEvents: 4 });

    for (let i = 0; i < 3; i++) {
      await store.storeEvent("stream-a", {
        id: i,
        jsonrpc: "2.0",
        method: `a/${i}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 3; i++) {
      await store.storeEvent("stream-b", {
        id: i,
        jsonrpc: "2.0",
        method: `b/${i}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // 6 events were stored across two streams; the store-wide cap still holds.
    expect(store.size).toBe(4);
  });

  it("prunes the per-stream replay index in step with eviction", async () => {
    // Replay walks a per-stream index instead of sorting the whole event map,
    // so that index is a second structure that has to stay in step with the
    // events it points at. Replay skips IDs it cannot resolve, which would hide
    // a desync behind correct-looking output - so assert the index itself.
    const store = new InMemoryEventStore({ maxEvents: 3 });
    const index = (
      store as unknown as { eventIdsByStream: Map<string, string[]> }
    ).eventIdsByStream;
    const streamId = "partially-evicted";

    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      eventIds.push(
        await store.storeEvent(streamId, {
          id: i,
          jsonrpc: "2.0",
          method: `step/${i}`,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The two evicted IDs are dropped from the index, and the survivors stay in
    // insertion order - which is what replay relies on to pick up mid-stream.
    expect(index.get(streamId)).toEqual(eventIds.slice(2));
  });

  it("drops the index entry for a stream whose events are all evicted", async () => {
    // A stream accumulates one event per server->client message, so a long
    // session opens many short-lived streams (#72). If a fully evicted stream
    // kept its index entry, that map would grow without bound even though the
    // event map itself stays capped.
    const store = new InMemoryEventStore({ maxEvents: 2 });
    const index = (
      store as unknown as { eventIdsByStream: Map<string, string[]> }
    ).eventIdsByStream;

    for (let i = 0; i < 5; i++) {
      await store.storeEvent(`stream-${i}`, {
        id: i,
        jsonrpc: "2.0",
        method: `step/${i}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(store.size).toBe(2);
    expect([...index.keys()]).toEqual(["stream-3", "stream-4"]);
  });

  it("defaults to a bounded size when maxEvents is not configured", async () => {
    const store = new InMemoryEventStore();
    const streamId = "default-cap-stream";

    for (let i = 0; i < 1010; i++) {
      await store.storeEvent(streamId, {
        id: i,
        jsonrpc: "2.0",
        method: "tools/list",
      });
    }

    expect(store.size).toBe(1000);
  });

  it("rejects a non-positive maxEvents", () => {
    expect(() => new InMemoryEventStore({ maxEvents: 0 })).toThrow(
      /maxEvents must be at least 1/,
    );
    expect(() => new InMemoryEventStore({ maxEvents: -1 })).toThrow(
      /maxEvents must be at least 1/,
    );
  });

  it("rejects a NaN maxEvents instead of silently disabling eviction", () => {
    // A naive `maxEvents < 1` check lets NaN through (every comparison with
    // NaN is false), which would make `size > maxEvents` never trigger and
    // silently reintroduce unbounded growth.
    expect(() => new InMemoryEventStore({ maxEvents: NaN })).toThrow(
      /maxEvents must be at least 1/,
    );
  });
});
