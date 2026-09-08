import type { Client } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";

import { describe, expect, it, vi } from "vitest";

import { proxyServer } from "./proxyServer.js";
import { ServerType, startStdioServer } from "./startStdioServer.js";

vi.mock("./proxyServer.js", () => ({ proxyServer: vi.fn() }));

const clientWithClose = (close: () => Promise<void>) =>
  ({
    close,
    connect: vi.fn().mockResolvedValue(undefined),
    getServerCapabilities: vi.fn().mockReturnValue({}),
    getServerVersion: vi
      .fn()
      .mockReturnValue({ name: "upstream", version: "1" }),
  }) as unknown as Client;

describe("startStdioServer startup cleanup", () => {
  it("closes an already-connected upstream client when stdio setup fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const client = clientWithClose(close);
    const startupError = new Error("stdio setup failed");

    await expect(
      startStdioServer({
        initStdioServer: vi.fn().mockRejectedValue(startupError),
        initStreamClient: vi.fn().mockResolvedValue(client),
        serverType: ServerType.HTTPStream,
        url: "https://example.com/mcp",
      }),
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves the startup error when closing the upstream client also fails", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const client = clientWithClose(close);
    const startupError = new Error("stdio setup failed");

    await expect(
      startStdioServer({
        initStdioServer: vi.fn().mockRejectedValue(startupError),
        initStreamClient: vi.fn().mockResolvedValue(client),
        serverType: ServerType.HTTPStream,
        url: "https://example.com/mcp",
      }),
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the upstream client when proxy initialization fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const client = clientWithClose(close);
    const startupError = new Error("proxy setup failed");
    vi.mocked(proxyServer).mockRejectedValueOnce(startupError);

    await expect(
      startStdioServer({
        initStdioServer: vi.fn().mockResolvedValue({} as Server),
        initStreamClient: vi.fn().mockResolvedValue(client),
        serverType: ServerType.HTTPStream,
        url: "https://example.com/mcp",
      }),
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledOnce();
  });
});
