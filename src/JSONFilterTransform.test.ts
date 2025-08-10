import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";

import { JSONFilterTransform } from "./JSONFilterTransform.js";

describe("JSONFilterTransform", () => {
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
    expect(outputLines[2]).toBe('  {"type": "notification"}  ');
    expect(outputLines[3]).toBe('{"type": "request", "id": 3}');

    // Should have warned about non-JSON lines
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[mcp-proxy] ignoring non-JSON output",
      expect.arrayContaining([
        "This is not JSON",
        "Another non-JSON line",
        "",
        "Error: something went wrong",
      ]),
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
});
