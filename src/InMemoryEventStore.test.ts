import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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
});
