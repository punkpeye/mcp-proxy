import type { IncomingMessage } from "http";

export interface AuthConfig {
  apiKey?: string;
  oauth?: {
    protectedResource?: {
      resource?: string;
    };
  };
}

export class AuthenticationMiddleware {
  constructor(private config: AuthConfig = {}) {}

  getUnauthorizedResponse(): { body: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add WWW-Authenticate header if OAuth config is available
    if (this.config.oauth?.protectedResource?.resource) {
      headers["WWW-Authenticate"] = `Bearer resource_metadata="${this.config.oauth.protectedResource.resource}/.well-known/oauth-protected-resource"`;
    }

    return {
      body: JSON.stringify({
        error: {
          code: 401,
          message: "Unauthorized: Invalid or missing API key",
        },
        id: null,
        jsonrpc: "2.0",
      }),
      headers,
    };
  }

  validateRequest(req: IncomingMessage): boolean {
    // No auth required if no API key configured (backward compatibility)
    if (!this.config.apiKey) {
      return true;
    }

    // Check X-API-Key header (case-insensitive)
    // Node.js http module automatically converts all header names to lowercase
    const apiKey = req.headers["x-api-key"];

    if (!apiKey || typeof apiKey !== "string") {
      return false;
    }

    return apiKey === this.config.apiKey;
  }
}

