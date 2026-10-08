import { getRandomPort } from "get-port-please";
import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Each case boots the CLI with `tsx`, which then spawns the stdio fixture, so
 * the wall clock is dominated by TypeScript transpilation. The explicit
 * timeouts give that room under parallel load.
 */
describe("mcp-proxy CLI endpoint options", () => {
  let proc: ChildProcess | undefined;

  afterEach(() => {
    proc?.kill();
    proc = undefined;
  });

  const startCli = async (options: string[]) => {
    const port = await getRandomPort("127.0.0.1");

    // Keep MCP_PROXY_* from the environment out of yargs' `.env()` lookup.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("MCP_PROXY"),
      ),
    );

    proc = spawn(
      "tsx",
      [
        "src/bin/mcp-proxy.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        ...options,
        "--",
        "tsx",
        "src/fixtures/simple-stdio-server.ts",
      ],
      { env, stdio: "pipe" },
    );

    const baseUrl = `http://127.0.0.1:${port}`;

    // The server listens a moment after it logs that it is starting.
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fetch(`${baseUrl}/`);

        return baseUrl;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw new Error("mcp-proxy did not start listening");
  };

  const initialize = (url: string) =>
    fetch(url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

  const openSseStream = async (url: string) => {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });

    controller.abort();

    return response.status;
  };

  it("serves the stream transport on --endpoint with --server stream", async () => {
    const baseUrl = await startCli([
      "--server",
      "stream",
      "--endpoint",
      "/custom",
    ]);

    expect((await initialize(`${baseUrl}/custom`)).status).toBe(200);
    expect((await initialize(`${baseUrl}/mcp`)).status).toBe(404);
  }, 30000);

  it("serves the SSE transport on --endpoint with --server sse", async () => {
    const baseUrl = await startCli([
      "--server",
      "sse",
      "--endpoint",
      "/custom",
    ]);

    expect(await openSseStream(`${baseUrl}/custom`)).toBe(200);
    expect(await openSseStream(`${baseUrl}/sse`)).toBe(404);
  }, 30000);

  it("lets --streamEndpoint override --endpoint", async () => {
    const baseUrl = await startCli([
      "--server",
      "stream",
      "--endpoint",
      "/ignored",
      "--streamEndpoint",
      "/chosen",
    ]);

    expect((await initialize(`${baseUrl}/chosen`)).status).toBe(200);
    expect((await initialize(`${baseUrl}/ignored`)).status).toBe(404);
  }, 30000);

  it("ignores --endpoint and keeps both defaults without --server", async () => {
    const baseUrl = await startCli(["--endpoint", "/custom"]);

    expect((await initialize(`${baseUrl}/mcp`)).status).toBe(200);
    expect(await openSseStream(`${baseUrl}/sse`)).toBe(200);
    expect((await initialize(`${baseUrl}/custom`)).status).toBe(404);
  }, 30000);
});
