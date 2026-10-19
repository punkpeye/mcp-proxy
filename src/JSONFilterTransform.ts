import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/client";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Largest incomplete line the filter will buffer before failing. A child that
 * writes a lot without ever completing a line would otherwise grow `this.buffer`
 * without bound: the downstream `ReadBuffer` cap never fires, because it only
 * sees data once a full line is flushed to it, so the filter sat in front of the
 * cap and could exhaust memory instead of failing.
 *
 * Set to twice the SDK's stdio buffer cap rather than equal to it. The filter
 * holds at most one line still being assembled, and a legitimate message is
 * bounded by that downstream cap - so a full-size (or even over-cap) message
 * must still reach `ReadBuffer`, which is the authority on message size and
 * rejects it there. The headroom lets that happen; anything past it is a line
 * that will never terminate, which is what this bound exists to stop.
 */
const MAX_BUFFER_SIZE = 2 * STDIO_DEFAULT_MAX_BUFFER_SIZE;

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
  // Decode bytes to text through a StringDecoder rather than chunk.toString():
  // a stdout pipe can split a multibyte UTF-8 character across two chunks, and
  // decoding each chunk on its own turns the split bytes into U+FFFD. The
  // decoder holds the incomplete sequence until its remaining bytes arrive.
  private decoder = new StringDecoder("utf8");

  constructor() {
    super({ objectMode: false });
  }

  _flush(callback: (error: Error | null, chunk: Buffer | null) => void) {
    // Flush any bytes the decoder is still holding for an incomplete character.
    this.buffer += this.decoder.end();
    // Handle any remaining data in buffer
    const json = extractJson(this.buffer);
    if (json !== null) {
      callback(null, Buffer.from(json + "\n"));
    } else {
      callback(null, null);
    }
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error: Error | null, chunk: Buffer | null) => void,
  ) {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    // A single line that never terminates would grow the buffer without bound,
    // ahead of and invisible to the downstream ReadBuffer cap. Fail here instead
    // of letting memory run out, matching how ReadBuffer reports its own limit.
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = "";
      callback(
        new Error(
          `JSONFilterTransform buffer exceeded maximum size of ${MAX_BUFFER_SIZE} bytes`,
        ),
        null,
      );
      return;
    }

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
