import type { IncomingMessage } from "http";

export interface AuthConfig {
  apiKey?: string;
}

export class AuthenticationMiddleware {
  constructor(private config: AuthConfig = {}) {}

  getUnauthorizedResponse() {
    return {
      body: JSON.stringify({
        error: {
          code: 401,
          message: "Unauthorized: Invalid or missing API key",
        },
        id: null,
        jsonrpc: "2.0",
      }),
      headers: {
        "Content-Type": "application/json",
      },
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

