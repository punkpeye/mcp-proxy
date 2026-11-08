import { describe, expect, it } from "vitest";

import {
  isMissingPipenet,
  loadPipenet,
  PipenetNotInstalledError,
} from "./loadPipenet.js";

const moduleNotFound = (message: string) =>
  Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });

describe("loadPipenet", () => {
  it("reports a missing pipenet with install instructions", async () => {
    const error = moduleNotFound(
      "Cannot find package 'pipenet' imported from /app/dist/bin/mcp-proxy.mjs",
    );

    await expect(
      loadPipenet(async () => {
        throw error;
      }),
    ).rejects.toBeInstanceOf(PipenetNotInstalledError);
    await expect(
      loadPipenet(async () => {
        throw error;
      }),
    ).rejects.toThrow("Install it with: npm install pipenet");
  });

  it("does not mask a broken transitive dependency", async () => {
    const error = moduleNotFound(
      "Cannot find package 'axios' imported from /app/node_modules/pipenet/index.js",
    );

    await expect(
      loadPipenet(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("pipenet failed to initialize");

    await expect(
      loadPipenet(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe("isMissingPipenet", () => {
  it("recognises a missing pipenet package", () => {
    expect(
      isMissingPipenet(
        moduleNotFound("Cannot find package 'pipenet' imported from x"),
      ),
    ).toBe(true);
  });

  it("ignores other packages, codes and non-errors", () => {
    expect(
      isMissingPipenet(moduleNotFound("Cannot find package 'koa' imported from x")),
    ).toBe(false);
    expect(
      isMissingPipenet(
        Object.assign(new Error("Cannot find package 'pipenet'"), {
          code: "MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(false);
    expect(isMissingPipenet("pipenet")).toBe(false);
  });
});
