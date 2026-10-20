import { Client } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// The integration regression exercises the actual SSE and stdio transports.
// These controlled close promises isolate ownership and callback semantics.
describe("startStdioServer owned upstream cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const setup = async (close: () => Promise<void>, customClient = false) => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "getServerVersion").mockReturnValue({
      name: "upstream",
      version: "1",
    });
    vi.spyOn(Client.prototype, "getServerCapabilities").mockReturnValue({});
    const closeClient = vi
      .spyOn(Client.prototype, "close")
      .mockImplementation(close);
    const server = new Server(
      { name: "stdio", version: "1" },
      { capabilities: {} },
    );
    const onclose = vi.fn();
    server.onclose = onclose;
    vi.spyOn(server, "connect").mockResolvedValue(undefined);
    vi.spyOn(server, "close").mockImplementation(async () => {
      server.onclose?.();
    });
    await startStdioServer({
      initStdioServer: async () => server,
      ...(customClient
        ? {
            initStreamClient: async () =>
              new Client({ name: "custom", version: "1" }),
          }
        : {}),
      serverType: ServerType.SSE,
      url: "http://localhost/sse",
    });
    return { closeClient, onclose, server };
  };

  it("awaits one upstream close across repeated closes and preserves the callback", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { closeClient, onclose, server } = await setup(() => pending);
    let settled = false;
    const closing = server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onclose).toHaveBeenCalledOnce();
    expect(closeClient).toHaveBeenCalledOnce();
    finish();
    await closing;
    await server.close();
    expect(closeClient).toHaveBeenCalledOnce();
  });

  it("observes callback cleanup failures and propagates them from explicit close", async () => {
    const failure = new Error("upstream close failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { closeClient, server } = await setup(async () => {
      throw failure;
    });
    server.onclose?.();
    await Promise.resolve();
    expect(logged).toHaveBeenCalledWith(
      "[mcp-proxy] error closing upstream client",
      failure,
    );
    await expect(server.close()).rejects.toBe(failure);
    expect(closeClient).toHaveBeenCalledOnce();
  });

  it("preserves a downstream close failure when upstream cleanup also fails", async () => {
    const primary = new Error("downstream close failed");
    const secondary = new Error("upstream close failed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { closeClient, onclose, server } = await setup(async () => {
      throw secondary;
    });
    onclose.mockImplementation(() => {
      throw primary;
    });
    await expect(server.close()).rejects.toBe(primary);
    expect(closeClient).toHaveBeenCalledOnce();
  });
  it("leaves caller-supplied clients open on ordinary stdio shutdown", async () => {
    const { closeClient, onclose, server } = await setup(async () => {}, true);
    await server.close();
    expect(onclose).toHaveBeenCalledOnce();
    expect(closeClient).not.toHaveBeenCalled();
  });
});
