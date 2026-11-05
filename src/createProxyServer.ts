import { Client } from "@modelcontextprotocol/client";
import { Server, ServerCapabilities } from "@modelcontextprotocol/server";

import { EVENTS_EXTENSION } from "./eventsExtension.js";

/**
 * What the upstream advertised, minus what the proxy cannot deliver.
 *
 * The events extension's `listChanged` promises
 * `notifications/events/list_changed` on a `subscriptions/listen` stream. The
 * proxy relays no such notification, and its listen leg never acknowledges
 * the `eventsListChanged` filter that asks for one, so it is advertised as
 * `false`. The rest of the settings object passes through unchanged.
 *
 * A changed result is a copy: the upstream object belongs to the client, and
 * every later caller reads it too.
 */
const deliverableCapabilities = (
  capabilities: ServerCapabilities,
): ServerCapabilities => {
  // `?.` because a closed client reports none, which passes through as before.
  const events = capabilities?.extensions?.[EVENTS_EXTENSION];

  if (events?.listChanged === undefined || events.listChanged === false) {
    return capabilities;
  }

  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [EVENTS_EXTENSION]: { ...events, listChanged: false },
    },
  };
};

export const createProxyServer = (client: Client) => {
  const serverVersion = client.getServerVersion() as {
    name: string;
    version: string;
  };
  const serverCapabilities = deliverableCapabilities(
    client.getServerCapabilities() as ServerCapabilities,
  );

  return {
    server: new Server(serverVersion, {
      capabilities: serverCapabilities,
      instructions: client.getInstructions(),
    }),
    serverCapabilities,
  };
};
