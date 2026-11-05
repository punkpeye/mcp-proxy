#!/usr/bin/env tsx
/**
 * A stdio server offering the MCP Events extension (SEP-3415) for webhook and
 * poll delivery - the half mcp-proxy forwards - served through `serveStdio`,
 * so either protocol era can reach it. Every events result carries an `echo`
 * of the params the handler was given, so a test can see what crossed.
 *
 * `events/subscribe` runs the SEP's endpoint verification: before it answers,
 * it POSTs a signed `verification` envelope to `delivery.url` and requires the
 * challenge echoed back. A webhook therefore reaches the caller's receiver
 * while the subscribe it belongs to is still in flight. The SEP's https-only
 * and public-address rules are skipped, because the receiver is a local test
 * server.
 *
 * - `MCP_FIXTURE_LEGACY=reject` refuses 2025-era openings, so a test can
 *   assert the proxy negotiated 2026-07-28 rather than falling back.
 * - `MCP_FIXTURE_EVENTS_LEGACY=hide` advertises the extension to 2026-07-28
 *   connections only, the revision SEP-3415 is defined for. The handlers stay
 *   registered either way, so a "method not found" can only be the proxy's.
 */

import type { StandardSchemaV1 } from "@modelcontextprotocol/server";

import { ProtocolError, Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHash, createHmac, randomBytes } from "node:crypto";

const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** SEP-3415's provisional `CallbackEndpointError` code. */
const CALLBACK_ENDPOINT_ERROR = -32027;

/**
 * Over stdio there is no caller to authenticate, so every request runs as
 * whoever started the process.
 */
const PRINCIPAL = "process-owner";

type Params = Record<string, unknown>;

const anyObject: StandardSchemaV1<Params> = {
  "~standard": {
    validate: (value) => ({ value: value as Params }),
    vendor: "events-fixture",
    version: 1,
  },
};

const callbackEndpointError = (reason: string) =>
  new ProtocolError(CALLBACK_ENDPOINT_ERROR, "CallbackEndpointError", {
    reason,
  });

/**
 * POSTs a `verification` envelope signed per Standard Webhooks, and resolves
 * once the receiver has echoed its challenge.
 */
const verifyEndpoint = async ({
  id,
  secret,
  url,
}: {
  id: string;
  secret: string;
  url: string;
}) => {
  const challenge = randomBytes(16).toString("hex");
  const body = JSON.stringify({ challenge, type: "verification" });
  const webhookId = `msg_verification_${randomBytes(8).toString("hex")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac(
    "sha256",
    Buffer.from(secret.slice("whsec_".length), "base64"),
  )
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64");

  const response = await fetch(url, {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-signature": `v1,${signature}`,
      "webhook-timestamp": timestamp,
      "x-mcp-subscription-id": id,
    },
    method: "POST",
    redirect: "manual",
  }).catch(() => undefined);

  if (response === undefined) {
    throw callbackEndpointError("connection_refused");
  }

  const echoed = response.ok
    ? await response.json().then(
        (reply) => (reply as { challenge?: unknown }).challenge,
        () => undefined,
      )
    : undefined;

  if (echoed !== challenge) {
    throw callbackEndpointError("challenge_failed");
  }
};

serveStdio(
  ({ era }) => {
    const advertised =
      era === "modern" || process.env.MCP_FIXTURE_EVENTS_LEGACY !== "hide";

    const server = new Server(
      { name: "events-server", version: "1.0.0" },
      {
        capabilities: advertised
          ? { extensions: { [EVENTS_EXTENSION]: {} } }
          : {},
      },
    );

    server.setRequestHandler(
      "events/list",
      { params: anyObject },
      async (params) => ({
        echo: params,
        events: [
          {
            delivery: ["webhook", "poll"],
            description: "Fires when a new incident is created",
            inputSchema: {
              properties: { severity: { type: "string" } },
              type: "object",
            },
            name: "incident.created",
            payloadSchema: {
              properties: { incidentId: { type: "string" } },
              type: "object",
            },
          },
        ],
      }),
    );

    server.setRequestHandler(
      "events/poll",
      { params: anyObject },
      async (params) => ({
        cursor: "cursor_after_poll",
        echo: params,
        events: [],
        hasMore: false,
        nextPollMs: 30_000,
        truncated: false,
      }),
    );

    server.setRequestHandler(
      "events/subscribe",
      { params: anyObject },
      async (params) => {
        const delivery = params.delivery as { secret: string; url: string };
        const id = `sub_${createHash("sha256")
          .update(
            JSON.stringify([
              PRINCIPAL,
              delivery.url,
              params.name,
              params.arguments,
            ]),
          )
          .digest("hex")
          .slice(0, 16)}`;

        await verifyEndpoint({
          id,
          secret: delivery.secret,
          url: delivery.url,
        });

        return {
          cursor: null,
          echo: params,
          id,
          refreshBefore: new Date(Date.now() + 3_600_000).toISOString(),
          truncated: false,
        };
      },
    );

    server.setRequestHandler(
      "events/unsubscribe",
      { params: anyObject },
      async (params) => ({ echo: params }),
    );

    return server;
  },
  {
    legacy: process.env.MCP_FIXTURE_LEGACY === "reject" ? "reject" : "serve",
  },
);
