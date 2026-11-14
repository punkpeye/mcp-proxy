import { Server } from "@modelcontextprotocol/server";
import { getRandomPort } from "get-port-please";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

import { type Logger, startHTTPServer } from "./startHTTPServer.js";

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const createServer = async () =>
  new Server({ name: "test", version: "1.0.0" }, { capabilities: {} });

const createLogger = () => ({ error: vi.fn(), info: vi.fn() }) satisfies Logger;

// The short hash a session is logged by.
const hashOf = (sessionId: string) =>
  createHash("sha256").update(sessionId).digest("hex").slice(0, 8);

const lines = (calls: unknown[][]) =>
  calls.map((args) => args.map(String).join(" "));

const initializeSession = async (port: number): Promise<string> => {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    }),
    headers,
    method: "POST",
  });

  expect(response.status).toBe(200);

  const sessionId = response.headers.get("mcp-session-id");

  expect(sessionId).toBeTruthy();

  await response.text();

  return sessionId!;
};

const deleteSession = async (port: number, sessionId: string) => {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    headers: { ...headers, "mcp-session-id": sessionId },
    method: "DELETE",
  });

  expect(response.ok).toBe(true);

  await response.text();
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("logs a session's stream and DELETE through the logger, by a hash of its id", async () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const logger = createLogger();
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({ createServer, logger, port });

  try {
    const sessionId = await initializeSession(port);

    const controller = new AbortController();
    const stream = await fetch(`http://localhost:${port}/mcp`, {
      headers: { ...headers, "mcp-session-id": sessionId },
      signal: controller.signal,
    });

    expect(stream.status).toBe(200);

    controller.abort();

    const reconnectController = new AbortController();

    await fetch(`http://localhost:${port}/mcp`, {
      headers: {
        ...headers,
        "last-event-id": "some-event",
        "mcp-session-id": sessionId,
      },
      signal: reconnectController.signal,
    });

    reconnectController.abort();

    await deleteSession(port, sessionId);

    const info = lines(logger.info.mock.calls);

    expect(info).toContain(
      `[mcp-proxy] establishing new SSE stream for session ${hashOf(sessionId)}`,
    );
    expect(info).toContain(
      `[mcp-proxy] client reconnecting with Last-Event-ID some-event for session ${hashOf(sessionId)}`,
    );
    expect(info).toContain(
      `[mcp-proxy] received delete request for session ${hashOf(sessionId)}`,
    );
    expect(info.some((line) => line.includes(sessionId))).toBe(false);

    // Nothing of mcp-proxy's own went around the logger
    const consoleLines = lines([
      ...consoleLog.mock.calls,
      ...consoleInfo.mock.calls,
    ]);

    expect(consoleLines.some((line) => line.includes("[mcp-proxy]"))).toBe(
      false,
    );
  } finally {
    await httpServer.close();
  }
});

it("logs an idle session it closes by a hash of its id", async () => {
  const logger = createLogger();
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({
    createServer,
    logger,
    port,
    sessionIdleTimeout: 250,
  });

  try {
    const sessionId = await initializeSession(port);

    await vi.waitFor(
      () =>
        expect(lines(logger.info.mock.calls)).toContain(
          `[mcp-proxy] closing session ${hashOf(sessionId)}, idle for over 250ms`,
        ),
      { timeout: 5_000 },
    );

    expect(
      lines(logger.info.mock.calls).some((line) => line.includes(sessionId)),
    ).toBe(false);
  } finally {
    await httpServer.close();
  }
}, 15_000);

it("sends errors to the logger rather than to console.error", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const logger = createLogger();
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({ createServer, logger, port });

  try {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      body: "{not json",
      headers,
      method: "POST",
    });

    await response.text();

    expect(lines(logger.error.mock.calls)[0]).toMatch(
      /^\[mcp-proxy\] error parsing body /,
    );
    expect(
      lines(consoleError.mock.calls).some((line) =>
        line.includes("[mcp-proxy]"),
      ),
    ).toBe(false);
  } finally {
    await httpServer.close();
  }
});

it("keeps session ids out of the console by default as well", async () => {
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const port = await getRandomPort();

  const httpServer = await startHTTPServer({ createServer, port });

  try {
    const sessionId = await initializeSession(port);

    await deleteSession(port, sessionId);

    const info = lines(consoleInfo.mock.calls);

    expect(info).toContain(
      `[mcp-proxy] received delete request for session ${hashOf(sessionId)}`,
    );
    expect(info.some((line) => line.includes(sessionId))).toBe(false);
  } finally {
    await httpServer.close();
  }
});
