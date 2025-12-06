import type { IncomingMessage } from "http";

export interface AuthConfig {
  apiKey?: string;
  oauth?: {
    error?: string;
    error_description?: string;
    error_uri?: string;
    protectedResource?: {
      resource?: string;
    };
    realm?: string;
    scope?: string;
  };
}

export class AuthenticationMiddleware {
  constructor(private config: AuthConfig = {}) {}

  getScopeChallengeResponse(
    requiredScopes: string[],
    errorDescription?: string,
    requestId?: unknown,
  ): { body: string; headers: Record<string, string>; statusCode: number } {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Build WWW-Authenticate header with all required parameters
    if (this.config.oauth?.protectedResource?.resource) {
      const parts = [
        "Bearer",
        'error="insufficient_scope"',
        `scope="${requiredScopes.join(" ")}"`,
        `resource_metadata="${this.config.oauth.protectedResource.resource}/.well-known/oauth-protected-resource"`,
      ];

      if (errorDescription) {
        // Escape quotes in description
        const escaped = errorDescription.replace(/"/g, '\\"');
        parts.push(`error_description="${escaped}"`);
      }

      headers["WWW-Authenticate"] = parts.join(", ");
    }

    return {
      body: JSON.stringify({
        error: {
          code: -32001, // Custom error code for insufficient scope
          data: {
            error: "insufficient_scope",
            required_scopes: requiredScopes,
          },
          message: errorDescription || "Insufficient scope",
        },
        id: requestId ?? null,
        jsonrpc: "2.0",
      }),
      headers,
      statusCode: 403,
    };
  }

  getUnauthorizedResponse(options?: {
    error?: string;
    error_description?: string;
    error_uri?: string;
    scope?: string;
  }): { body: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Build WWW-Authenticate header if OAuth config is available
    if (this.config.oauth) {
      const params: string[] = [];

      // Add realm if configured
      if (this.config.oauth.realm) {
        params.push(`realm="${this.config.oauth.realm}"`);
      }

      // Add resource_metadata if configured
      if (this.config.oauth.protectedResource?.resource) {
        params.push(
          `resource_metadata="${this.config.oauth.protectedResource.resource}/.well-known/oauth-protected-resource"`,
        );
      }

      // Add error from options or config (options takes precedence)
      const error =
        options?.error || this.config.oauth.error || "invalid_token";
      params.push(`error="${error}"`);

      // Add error_description from options or config (options takes precedence)
      const error_description =
        options?.error_description ||
        this.config.oauth.error_description ||
        "Unauthorized: Invalid or missing API key";
      // Escape quotes in error description
      const escaped = error_description.replace(/"/g, '\\"');
      params.push(`error_description="${escaped}"`);

      // Add error_uri from options or config (options takes precedence)
      const error_uri = options?.error_uri || this.config.oauth.error_uri;
      if (error_uri) {
        params.push(`error_uri="${error_uri}"`);
      }

      // Add scope from options or config (options takes precedence)
      const scope = options?.scope || this.config.oauth.scope;
      if (scope) {
        params.push(`scope="${scope}"`);
      }

      if (params.length > 0) {
        headers["WWW-Authenticate"] = `Bearer ${params.join(", ")}`;
      }
    }

    return {
      body: JSON.stringify({
        error: {
          code: 401,
          message:
            options?.error_description ||
            "Unauthorized: Invalid or missing API key",
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
