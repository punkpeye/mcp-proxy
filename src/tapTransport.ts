import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type TransportEvent =
  | {
      type: "close";
    }
  | {
      type: "onclose";
    }
  | {
      type: "onerror";
      error: Error;
    }
  | {
      type: "onmessage";
      message: JSONRPCMessage;
    }
  | {
      type: "send";
      message: JSONRPCMessage;
    }
  | {
      type: "start";
    };

export const tapTransport = (
  transport: Transport,
  eventHandler: (event: TransportEvent) => void,
) => {
  const originalClose = transport.close.bind(transport);
  const originalOnClose = transport.onclose?.bind(transport);
  const originalOnError = transport.onerror?.bind(transport);
  const originalOnMessage = transport.onmessage?.bind(transport);
  const originalSend = transport.send.bind(transport);
  const originalStart = transport.start.bind(transport);

  transport.close = async () => {
    eventHandler({
      type: "close",
    });

    return originalClose?.();
  };

  transport.onclose = async () => {
    eventHandler({
      type: "onclose",
    });

    return originalOnClose?.();
  };

  transport.onerror = async (error: Error) => {
    eventHandler({
      type: "onerror",
      error,
    });

    return originalOnError?.(error);
  };

  transport.onmessage = async (message: JSONRPCMessage) => {
    eventHandler({
      type: "onmessage",
      message,
    });

    return originalOnMessage?.(message);
  };

  transport.send = async (message: JSONRPCMessage) => {
    eventHandler({
      type: "send",
      message,
    });

    return originalSend?.(message);
  };

  transport.start = async () => {
    eventHandler({
      type: "start",
    });

    return originalStart?.();
  };

  return transport;
};
