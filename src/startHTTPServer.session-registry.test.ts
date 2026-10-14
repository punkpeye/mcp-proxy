import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type SSEServer, startHTTPServer } from "./startHTTPServer.js";

// Session ids that a plain object resolves to a built-in instead of missing.
const inheritedNames = ["__proto__", "constructor", "toString"];

// Where a lookup that hit one of those would write its stream bookkeeping.
const builtIns = [Object.prototype, Object, Object.prototype.toString];
const bookkeeping = ["lastActivityAt", "openStreams"];

const writesOnBuiltIns = () =>
  builtIns.flatMap((builtIn) =>
    bookkeeping.filter((key) => Object.hasOwn(builtIn, key)),
  );

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const ping = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" });

const requests: [
  string,
  (url: string, sessionId: string) => Promise<Response>,
  number,
][] = [
  [
    "stream POST",
    (url, sessionId) =>
      fetch(`${url}/mcp`, {
        body: ping,
        headers: { ...headers, "mcp-session-id": sessionId },
        method: "POST",
      }),
    404,
  ],
  [
    "stream GET",
    (url, sessionId) =>
      fetch(`${url}/mcp`, {
        headers: { ...headers, "mcp-session-id": sessionId },
      }),
    404,
  ],
  [
    "stream DELETE",
    (url, sessionId) =>
      fetch(`${url}/mcp`, {
        headers: { ...headers, "mcp-session-id": sessionId },
        method: "DELETE",
      }),
    404,
  ],
  [
    "legacy SSE message POST",
    (url, sessionId) =>
      fetch(`${url}/messages?sessionId=${encodeURIComponent(sessionId)}`, {
        body: ping,
        headers,
        method: "POST",
      }),
    400,
  ],
];

let httpServer: SSEServer;
let url: string;

beforeAll(async () => {
  const port = await getRandomPort();

  httpServer = await startHTTPServer({
    createServer: async () =>
      new Server({ name: "test", version: "1.0.0" }, { capabilities: {} }),
    port,
  });

  url = `http://localhost:${port}`;
});

afterAll(async () => {
  await httpServer.close();
});

afterEach(() => {
  // Undo a regression's writes so that it fails only its own test.
  for (const builtIn of builtIns) {
    for (const key of bookkeeping) {
      Reflect.deleteProperty(builtIn, key);
    }
  }
});

describe.each(inheritedNames)("session id %s", (sessionId) => {
  it.each(requests)(
    "misses on a %s like any unknown id",
    async (_name, send, status) => {
      const response = await send(url, sessionId);

      await response.text();

      expect(response.status).toBe(status);
      expect(writesOnBuiltIns()).toEqual([]);
    },
  );
});
