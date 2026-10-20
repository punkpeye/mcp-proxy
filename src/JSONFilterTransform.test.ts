import { ReadBuffer } from "@modelcontextprotocol/client";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";

import { JSONFilterTransform } from "./JSONFilterTransform.js";

describe("JSONFilterTransform", () => {
  it.each(["", "\n", "\r\n"])(
    "delivers the final JSON-RPC message to ReadBuffer with terminator %j",
    async (terminator) => {
      const message = { id: 1, jsonrpc: "2.0", result: { ok: true } };
      const readBuffer = new ReadBuffer();
      await pipeline(
        Readable.from([JSON.stringify(message) + terminator]),
        new JSONFilterTransform(),
        new Writable({
          write(chunk, _encoding, callback) {
            readBuffer.append(chunk);
            callback();
          },
        }),
      );

      expect(readBuffer.readMessage()).toEqual(message);
      expect(readBuffer.readMessage()).toBeNull();
    },
  );

  it.each(['{"jsonrpc":"2.0",', '{}'])(
    "passes invalid trailing data %j through to SDK validation",
    async (input) => {
      const readBuffer = new ReadBuffer();
      const chunks: Buffer[] = [];
      await pipeline(
        Readable.from([input]),
        new JSONFilterTransform(),
        new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk);
            readBuffer.append(chunk);
            callback();
          },
        }),
      );

      expect(Buffer.concat(chunks).toString()).toBe(input + "\n");
      if (input === "{}") {
        expect(() => readBuffer.readMessage()).toThrow();
      } else {
        // The SDK skips malformed JSON, but propagates schema validation errors.
        expect(readBuffer.readMessage()).toBeNull();
      }
    },
  );

  it("filters out non-JSON lines and passes through JSON lines", async () => {
    const input = [
      '{"type": "request", "id": 1}',
      "This is not JSON",
      '{"type": "response", "id": 2}',
      "Another non-JSON line",
      '  {"type": "notification"}  ',
      "",
      "Error: something went wrong",
      '{"type": "request", "id": 3}',
    ].join("\n");

    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const readable = Readable.from([input]);
    const transform = new JSONFilterTransform();
    const chunks: Buffer[] = [];

    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    await pipeline(readable, transform, writable);

    const output = Buffer.concat(chunks).toString();
    const outputLines = output.trim().split("\n");

    // Should only contain the JSON lines
    expect(outputLines).toHaveLength(4);
    expect(outputLines[0]).toBe('{"type": "request", "id": 1}');
    expect(outputLines[1]).toBe('{"type": "response", "id": 2}');
    expect(outputLines[2]).toBe('{"type": "notification"}');
    expect(outputLines[3]).toBe('{"type": "request", "id": 3}');

    // Should have warned about non-JSON lines
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[mcp-proxy] ignoring non-JSON output",
      expect.arrayContaining([
        "This is not JSON",
        "Another non-JSON line",
        "Error: something went wrong",
      ]),
    );

    consoleWarnSpy.mockRestore();
  });

  it("extracts JSON from lines with non-JSON prefixes", async () => {
    const input = [
      'Loading...{"type": "request", "id": 1}',
      'WARNING: deprecation{"type": "response", "id": 2}',
      '{"type": "clean", "id": 3}',
      "Pure noise with no JSON",
    ].join("\n");

    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const readable = Readable.from([input]);
    const transform = new JSONFilterTransform();
    const chunks: Buffer[] = [];

    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    await pipeline(readable, transform, writable);

    const output = Buffer.concat(chunks).toString();
    const outputLines = output.trim().split("\n");

    expect(outputLines).toHaveLength(3);
    expect(outputLines[0]).toBe('{"type": "request", "id": 1}');
    expect(outputLines[1]).toBe('{"type": "response", "id": 2}');
    expect(outputLines[2]).toBe('{"type": "clean", "id": 3}');

    // Should have warned about stripped prefixes
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[mcp-proxy] stripped non-JSON prefix from output:",
      "Loading...",
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[mcp-proxy] stripped non-JSON prefix from output:",
      "WARNING: deprecation",
    );

    consoleWarnSpy.mockRestore();
  });

  it("handles incomplete JSON lines across multiple chunks", async () => {
    // Simulate data arriving in chunks where JSON lines are split
    const chunks = [
      '{"type": "req',
      'uest", "id": 1}\n',
      'Some error message\n{"type',
      '": "response", ',
      '"id": 2}\n',
      '{"partial":',
      ' "data"',
      "}",
    ];

    const transform = new JSONFilterTransform();
    const outputChunks: Buffer[] = [];

    const writable = new Writable({
      write(chunk, _encoding, callback) {
        outputChunks.push(chunk);
        callback();
      },
    });

    // Create a readable stream that emits chunks one by one
    const readable = new Readable({
      read() {
        if (chunks.length > 0) {
          this.push(chunks.shift());
        } else {
          this.push(null); // End the stream
        }
      },
    });

    await pipeline(readable, transform, writable);

    const output = Buffer.concat(outputChunks).toString();
    const outputLines = output.trim().split("\n");

    // Should correctly reassemble and filter JSON lines
    expect(outputLines).toHaveLength(3);
    expect(outputLines[0]).toBe('{"type": "request", "id": 1}');
    expect(outputLines[1]).toBe('{"type": "response", "id": 2}');
    expect(outputLines[2]).toBe('{"partial": "data"}');
  });
  it("fails instead of buffering an unbounded line with no newline", async () => {
    // Regression test (#85): a child that writes a lot without ever completing a
    // line grew `this.buffer` without bound. The downstream ReadBuffer cap never
    // fired, because it only sees data once a full line is flushed to it - so the
    // filter sat in front of the cap and could exhaust memory instead of failing.
    // The buffer is now bounded. The cap is twice the SDK's stdio buffer size, so
    // a complete (even over-cap) message still reaches ReadBuffer for the
    // authoritative rejection; this covers the other case - a line that never
    // terminates and so never reaches ReadBuffer at all.
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const transform = new JSONFilterTransform();

    // 21 MiB in one chunk with no newline: over the 20 MiB cap (2x the SDK's
    // 10 MiB stdio buffer), and never flushed downstream because there is no line
    // terminator.
    const oversized = "x".repeat(21 * 1024 * 1024);
    const readable = Readable.from([oversized]);

    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await expect(pipeline(readable, transform, writable)).rejects.toThrow(
      /buffer exceeded maximum size/,
    );

    consoleWarnSpy.mockRestore();
  });

  it("preserves multibyte UTF-8 characters split across chunk boundaries", async () => {
    // Regression: _transform decoded each chunk with chunk.toString(), so a
    // multibyte UTF-8 character whose bytes landed in two different stdout
    // chunks was decoded as two invalid halves and replaced with U+FFFD -
    // silently corrupting any non-ASCII text (emoji, accented Latin, CJK) in a
    // proxied JSON-RPC message. A StringDecoder holds the partial sequence.
    const message = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: { text: "launch \u{1F680} Configuraci\u00F3n a\u00F1adi\u00F3" },
    });
    const full = Buffer.from(message + "\n", "utf8");

    // One byte per chunk is the worst case, and a real one: a slow writer or a
    // pipe under backpressure delivers stdout a few bytes at a time.
    const byteChunks: Buffer[] = [];
    for (let i = 0; i < full.length; i++) {
      byteChunks.push(full.subarray(i, i + 1));
    }

    const readable = Readable.from(byteChunks);
    const transform = new JSONFilterTransform();
    const outputChunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        outputChunks.push(chunk);
        callback();
      },
    });

    await pipeline(readable, transform, writable);

    const output = Buffer.concat(outputChunks).toString("utf8").trim();
    expect(output).not.toContain("\uFFFD");
    expect(output).toBe(message);
  });
});
