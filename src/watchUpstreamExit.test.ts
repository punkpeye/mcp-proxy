import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { StdioClientTransport } from "./StdioClientTransport.js";
import { watchUpstreamExit } from "./watchUpstreamExit.js";

const connectUpstream = async () => {
  const client = new Client({ name: "mcp-proxy", version: "1.0.0" });

  await client.connect(
    new StdioClientTransport({
      args: ["src/fixtures/exiting-stdio-server.ts"],
      command: "tsx",
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  return client;
};

describe("watchUpstreamExit", () => {
  it("reports an upstream stdio server that exits on its own", async () => {
    const client = await connectUpstream();
    const onExit = vi.fn();

    watchUpstreamExit({ client, isClosing: () => false, onExit });

    await expect(
      client.callTool({ arguments: {}, name: "disconnect" }),
    ).rejects.toThrow();

    await vi.waitFor(() => {
      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });

  it("stays quiet when the proxy closes the upstream itself", async () => {
    const client = await connectUpstream();
    const onExit = vi.fn();
    let closing = false;

    watchUpstreamExit({ client, isClosing: () => closing, onExit });

    closing = true;
    await client.close();

    expect(onExit).not.toHaveBeenCalled();
  });

  it("keeps an onclose handler that was already installed", async () => {
    const client = await connectUpstream();
    const previous = vi.fn();
    client.onclose = previous;

    watchUpstreamExit({ client, isClosing: () => true, onExit: vi.fn() });

    await client.close();

    expect(previous).toHaveBeenCalledTimes(1);
  });
});
