/**
 * This is a copy of the InMemoryEventStore from the typescript-sdk
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/examples/shared/inMemoryEventStore.ts
 */

import type { EventStore, JSONRPCMessage } from "@modelcontextprotocol/server";

// A stream accumulates one event per server->client message (e.g. every
// tool call on a stateful session opens its own stream). With no cap, a
// single long-lived session climbs without bound - see
// https://github.com/punkpeye/mcp-proxy/issues/72.
const DEFAULT_MAX_EVENTS = 1000;

export interface InMemoryEventStoreOptions {
  /**
   * Maximum number of events retained across all streams before the oldest
   * are evicted (FIFO). Bounds memory use; older reconnect attempts beyond
   * this window fall back to a fresh (non-resumed) stream instead of a replay.
   *
   * @default 1000
   */
  maxEvents?: number;
}

/**
 * Simple in-memory implementation of the EventStore interface for resumability
 * This is primarily intended for examples and testing, not for production use
 * where a persistent storage solution would be more appropriate.
 */
export class InMemoryEventStore implements EventStore {
  /**
   * The number of events currently retained (for observability/testing).
   */
  get size(): number {
    return this.events.size;
  }
  private events: Map<string, { message: JSONRPCMessage; streamId: string }> =
    new Map();
  private lastTimestamp = 0;
  private lastTimestampCounter = 0;

  private readonly maxEvents: number;

  constructor(options: InMemoryEventStoreOptions = {}) {
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

    // Written as `!(maxEvents >= 1)` rather than `maxEvents < 1` so NaN
    // (every comparison with NaN is false) is rejected too - otherwise
    // `size > maxEvents` would never trigger eviction and silently
    // reintroduce unbounded growth.
    if (!(maxEvents >= 1)) {
      throw new Error("maxEvents must be at least 1");
    }

    this.maxEvents = maxEvents;
  }

  /**
   * Replays events that occurred after a specific event ID
   * Implements EventStore.replayEventsAfter
   */
  async replayEventsAfter(
    lastEventId: string,
    {
      send,
    }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return "";
    }

    // Extract the stream ID from the event ID
    const streamId = this.getStreamIdFromEventId(lastEventId);

    if (!streamId) {
      return "";
    }

    let foundLastEvent = false;

    // Sort events by eventId for chronological ordering
    const sortedEvents = [...this.events.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    for (const [
      eventId,
      { message, streamId: eventStreamId },
    ] of sortedEvents) {
      // Only include events from the same stream
      if (eventStreamId !== streamId) {
        continue;
      }

      // Start sending events after we find the lastEventId
      if (eventId === lastEventId) {
        foundLastEvent = true;
        continue;
      }

      if (foundLastEvent) {
        await send(eventId, message);
      }
    }

    return streamId;
  }

  /**
   * Stores an event with a generated event ID
   * Implements EventStore.storeEvent
   */
  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId);

    this.events.set(eventId, { message, streamId });

    // Map iterates in insertion order, so the first key is always the
    // oldest surviving event - evicting it is a plain FIFO/ring buffer.
    while (this.events.size > this.maxEvents) {
      const oldestEventId = this.events.keys().next().value;

      if (oldestEventId === undefined) {
        break;
      }

      this.events.delete(oldestEventId);
    }

    return eventId;
  }

  /**
   * Generates a monotonic unique event ID in
   * `${streamId}_${timestamp}_${counter}_${random}` format.
   */
  private generateEventId(streamId: string): string {
    const now = Date.now();

    if (now === this.lastTimestamp) {
      this.lastTimestampCounter++;
    } else {
      this.lastTimestampCounter = 0;
      this.lastTimestamp = now;
    }

    const timestamp = now.toString();
    const counter = this.lastTimestampCounter.toString(36).padStart(4, "0");
    const random = Math.random().toString(36).substring(2, 5);

    return `${streamId}_${timestamp}_${counter}_${random}`;
  }

  /**
   * Extracts the stream ID from an event ID
   */
  private getStreamIdFromEventId(eventId: string): string {
    const parts = eventId.split("_");

    return parts.length > 0 ? parts[0] : "";
  }
}
