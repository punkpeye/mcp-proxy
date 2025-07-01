import { Transform } from "node:stream";

/**
 * Filters out lines that do not start with '{' from the input stream.
 * We use this to drop anything that is obviously not a JSON-RPC message.
 */
export class JSONFilterTransform extends Transform {
  private buffer = "";

  constructor() {
    super({ objectMode: false });
  }

  _flush(callback: (error: Error | null, chunk: Buffer | null) => void) {
    // Handle any remaining data in buffer
    if (this.buffer.trim().startsWith("{")) {
      callback(null, Buffer.from(this.buffer));
    } else {
      callback(null, null);
    }
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error: Error | null, chunk: Buffer | null) => void,
  ) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    // Filter lines that start with '{'
    const jsonLines = [];
    const nonJsonLines = [];

    for (const line of lines) {
      if (line.trim().startsWith("{")) {
        jsonLines.push(line);
      } else {
        nonJsonLines.push(line);
      }
    }

    if (nonJsonLines.length > 0) {
      console.warn("[mcp-proxy] ignoring non-JSON output", nonJsonLines);
    }

    if (jsonLines.length > 0) {
      // Send filtered lines with newlines
      const output = jsonLines.join("\n") + "\n";

      callback(null, Buffer.from(output));
    } else {
      callback(null, null);
    }
  }
}
