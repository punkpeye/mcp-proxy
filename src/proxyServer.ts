import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  ReadResourceRequestSchema,
  ResourceUpdatedNotificationSchema,
  ServerCapabilities,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const proxyServer = async ({
  client,
  requestTimeout,
  server,
  serverCapabilities,
}: {
  client: Client;
  requestTimeout?: number;
  server: Server;
  serverCapabilities: ServerCapabilities;
}): Promise<void> => {
  if (serverCapabilities?.logging) {
    server.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (args) => {
        return client.notification(args);
      },
    );
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      async (args) => {
        return server.notification(args);
      },
    );
  }

  if (serverCapabilities?.prompts) {
    server.setRequestHandler(GetPromptRequestSchema, async (args) => {
      return client.getPrompt(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });

    server.setRequestHandler(ListPromptsRequestSchema, async (args) => {
      return client.listPrompts(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });
  }

  if (serverCapabilities?.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (args) => {
      return client.listResources(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });

    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (args) => {
        return client.listResourceTemplates(
          args.params,
          requestTimeout ? { timeout: requestTimeout } : undefined,
        );
      },
    );

    server.setRequestHandler(ReadResourceRequestSchema, async (args) => {
      return client.readResource(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });

    if (serverCapabilities?.resources.subscribe) {
      server.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        async (args) => {
          return client.notification(args);
        },
      );

      server.setRequestHandler(SubscribeRequestSchema, async (args) => {
        return client.subscribeResource(
          args.params,
          requestTimeout ? { timeout: requestTimeout } : undefined,
        );
      });

      server.setRequestHandler(UnsubscribeRequestSchema, async (args) => {
        return client.unsubscribeResource(
          args.params,
          requestTimeout ? { timeout: requestTimeout } : undefined,
        );
      });
    }
  }

  if (serverCapabilities?.tools) {
    server.setRequestHandler(CallToolRequestSchema, async (args) => {
      return client.callTool(
        args.params,
        undefined,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });

    server.setRequestHandler(ListToolsRequestSchema, async (args) => {
      return client.listTools(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });
  }

  if (serverCapabilities?.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (args) => {
      return client.complete(
        args.params,
        requestTimeout ? { timeout: requestTimeout } : undefined,
      );
    });
  }
};
