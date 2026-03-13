import { Transform } from "node:stream";

/**
 * Extracts JSON-RPC messages from a stream that may contain non-JSON output.
 *
 * Lines that start with '{' are passed through as-is. Lines that contain '{'
 * but have a non-JSON prefix (e.g. Python warnings prepended to a JSON message)
 * have the prefix stripped and the JSON portion extracted. Lines with no '{'
 * are dropped entirely.
 */
export class JSONFilterTransform extends Transform {
  private buffer = "";

  constructor() {
    super({ objectMode: false });
  }

  _flush(callback: (error: Error | null, chunk: Buffer | null) => void) {
    // Handle any remaining data in buffer
    const json = extractJson(this.buffer);
    if (json !== null) {
      callback(null, Buffer.from(json));
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

    const jsonLines = [];
    const nonJsonLines = [];

    for (const line of lines) {
      const json = extractJson(line);
      if (json !== null) {
        jsonLines.push(json);
      } else if (line.trim().length > 0) {
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

/**
 * Extracts the JSON portion from a line that may have a non-JSON prefix.
 * Returns null if the line contains no '{'.
 */
function extractJson(line: string): null | string {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) {
    return null;
  }

  if (braceIndex === 0) {
    return trimmed;
  }

  // There's a non-JSON prefix — strip it and return from the first '{'
  const jsonPart = trimmed.slice(braceIndex);
  console.warn(
    "[mcp-proxy] stripped non-JSON prefix from output:",
    trimmed.slice(0, braceIndex),
  );
  return jsonPart;
}
