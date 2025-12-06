import { IncomingMessage } from "http";
import { describe, expect, it } from "vitest";

import { AuthenticationMiddleware } from "./authentication.js";

describe("AuthenticationMiddleware", () => {
  const createMockRequest = (
    headers: Record<string, string> = {},
  ): IncomingMessage => {
    // Simulate Node.js http module behavior which converts all header names to lowercase
    const lowercaseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      lowercaseHeaders[key.toLowerCase()] = value;
    }
    return {
      headers: lowercaseHeaders,
    } as IncomingMessage;
  };

  describe("when no auth is configured", () => {
    it("should allow all requests", () => {
      const middleware = new AuthenticationMiddleware({});
      const req = createMockRequest();

      expect(middleware.validateRequest(req)).toBe(true);
    });

    it("should allow requests even with headers", () => {
      const middleware = new AuthenticationMiddleware({});
      const req = createMockRequest({ "x-api-key": "some-key" });

      expect(middleware.validateRequest(req)).toBe(true);
    });
  });

  describe("X-API-Key validation", () => {
    const apiKey = "test-api-key-123";

    it("should accept valid API key", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest({ "x-api-key": apiKey });

      expect(middleware.validateRequest(req)).toBe(true);
    });

    it("should reject missing API key", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest();

      expect(middleware.validateRequest(req)).toBe(false);
    });

    it("should reject incorrect API key", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest({ "x-api-key": "wrong-key" });

      expect(middleware.validateRequest(req)).toBe(false);
    });

    it("should reject empty API key", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest({ "x-api-key": "" });

      expect(middleware.validateRequest(req)).toBe(false);
    });

    it("should be case-insensitive for header names", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest({ "X-API-KEY": apiKey });

      expect(middleware.validateRequest(req)).toBe(true);
    });

    it("should work with mixed case header names", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = createMockRequest({ "X-Api-Key": apiKey });

      expect(middleware.validateRequest(req)).toBe(true);
    });

    it("should handle array headers (if multiple same headers)", () => {
      const middleware = new AuthenticationMiddleware({ apiKey });
      const req = {
        headers: {
          "x-api-key": [apiKey, "another-key"],
        },
      } as unknown as IncomingMessage;

      // Should fail because header is an array, not a string
      expect(middleware.validateRequest(req)).toBe(false);
    });
  });

  describe("getUnauthorizedResponse", () => {
    it("should return proper unauthorized response", () => {
      const middleware = new AuthenticationMiddleware({ apiKey: "test" });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe(401);
      expect(body.error.message).toBe(
        "Unauthorized: Invalid or missing API key",
      );
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(null);
    });

    it("should have consistent body format regardless of configuration", () => {
      const middleware1 = new AuthenticationMiddleware({});
      const middleware2 = new AuthenticationMiddleware({ apiKey: "test" });

      const response1 = middleware1.getUnauthorizedResponse();
      const response2 = middleware2.getUnauthorizedResponse();

      expect(response1.body).toEqual(response2.body);
    });

    it("should not include WWW-Authenticate header without OAuth config", () => {
      const middleware = new AuthenticationMiddleware({ apiKey: "test" });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBeUndefined();
    });

    it("should include WWW-Authenticate header with OAuth config", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBe(
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Unauthorized: Invalid or missing API key"',
      );
    });

    it("should handle OAuth config with trailing slash in resource URL", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com/",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBe(
        'Bearer resource_metadata="https://example.com//.well-known/oauth-protected-resource", error="invalid_token", error_description="Unauthorized: Invalid or missing API key"',
      );
    });

    it("should include minimal WWW-Authenticate header when OAuth config is empty object", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {},
      });
      const response = middleware.getUnauthorizedResponse();

      // Even with empty oauth object, default error and error_description are added
      expect(response.headers["WWW-Authenticate"]).toBe(
        'Bearer error="invalid_token", error_description="Unauthorized: Invalid or missing API key"',
      );
    });

    it("should include minimal WWW-Authenticate header when protectedResource is empty", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {},
        },
      });
      const response = middleware.getUnauthorizedResponse();

      // Even without resource_metadata, default error and error_description are added
      expect(response.headers["WWW-Authenticate"]).toBe(
        'Bearer error="invalid_token", error_description="Unauthorized: Invalid or missing API key"',
      );
    });

    it("should include WWW-Authenticate header with OAuth config but no apiKey", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBe(
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="Unauthorized: Invalid or missing API key"',
      );
    });

    it("should include realm in WWW-Authenticate header when configured", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
          realm: "example-realm",
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toContain(
        'realm="example-realm"',
      );
      expect(response.headers["WWW-Authenticate"]).toContain(
        'resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
      );
    });

    it("should include custom error in WWW-Authenticate header via options", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse({
        error: "insufficient_scope",
        error_description: "The request requires higher privileges",
      });

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error="insufficient_scope"',
      );
      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_description="The request requires higher privileges"',
      );
    });

    it("should include scope in WWW-Authenticate header", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
          scope: "read write",
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toContain(
        'scope="read write"',
      );
    });

    it("should override config error with options error", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          error: "invalid_request",
          error_description: "Config error description",
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse({
        error: "invalid_token",
        error_description: "Options error description",
      });

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error="invalid_token"',
      );
      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_description="Options error description"',
      );
      expect(response.headers["WWW-Authenticate"]).not.toContain(
        "invalid_request",
      );
      expect(response.headers["WWW-Authenticate"]).not.toContain(
        "Config error description",
      );
    });

    it("should include error_uri in WWW-Authenticate header", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          error_uri: "https://example.com/errors/auth",
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_uri="https://example.com/errors/auth"',
      );
    });

    it("should properly escape quotes in error_description", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getUnauthorizedResponse({
        error_description: 'Token "abc123" is invalid',
      });

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_description="Token \\"abc123\\" is invalid"',
      );
    });

    it("should include all parameters in correct order", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          error: "invalid_token",
          error_description: "Token expired",
          error_uri: "https://example.com/errors",
          protectedResource: {
            resource: "https://example.com",
          },
          realm: "my-realm",
          scope: "read write",
        },
      });
      const response = middleware.getUnauthorizedResponse();

      const header = response.headers["WWW-Authenticate"];
      expect(header).toContain('realm="my-realm"');
      expect(header).toContain(
        'resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
      );
      expect(header).toContain('error="invalid_token"');
      expect(header).toContain('error_description="Token expired"');
      expect(header).toContain('error_uri="https://example.com/errors"');
      expect(header).toContain('scope="read write"');

      // Check order: realm, resource_metadata, error, error_description, error_uri, scope
      expect(header.indexOf("realm=")).toBeLessThan(
        header.indexOf("resource_metadata="),
      );
      expect(header.indexOf("resource_metadata=")).toBeLessThan(
        header.indexOf("error="),
      );
      expect(header.indexOf("error=")).toBeLessThan(
        header.indexOf("error_description="),
      );
    });
  });

  describe("getScopeChallengeResponse", () => {
    it("should return 403 status code", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(["read", "write"]);

      expect(response.statusCode).toBe(403);
    });

    it("should include required scopes in WWW-Authenticate header", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(["read", "write"]);

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error="insufficient_scope"',
      );
      expect(response.headers["WWW-Authenticate"]).toContain(
        'scope="read write"',
      );
      expect(response.headers["WWW-Authenticate"]).toContain(
        'resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
      );
    });

    it("should include error_description in WWW-Authenticate header", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(
        ["admin"],
        "Admin access required",
      );

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_description="Admin access required"',
      );
    });

    it("should escape quotes in error_description", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(
        ["admin"],
        'Requires "admin" scope',
      );

      expect(response.headers["WWW-Authenticate"]).toContain(
        'error_description="Requires \\"admin\\" scope"',
      );
    });

    it("should include request ID in response body", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(
        ["read"],
        undefined,
        123,
      );

      const body = JSON.parse(response.body);
      expect(body.id).toBe(123);
    });

    it("should include required scopes in response body data", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(["read", "write"]);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toBe("Insufficient scope");
      expect(body.error.data.error).toBe("insufficient_scope");
      expect(body.error.data.required_scopes).toEqual(["read", "write"]);
    });

    it("should use custom error_description in response body message", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(
        ["admin"],
        "Admin privileges required",
      );

      const body = JSON.parse(response.body);
      expect(body.error.message).toBe("Admin privileges required");
    });

    it("should handle single scope", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(["admin"]);

      expect(response.headers["WWW-Authenticate"]).toContain('scope="admin"');
      const body = JSON.parse(response.body);
      expect(body.error.data.required_scopes).toEqual(["admin"]);
    });

    it("should handle multiple scopes", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse([
        "read",
        "write",
        "admin",
      ]);

      expect(response.headers["WWW-Authenticate"]).toContain(
        'scope="read write admin"',
      );
      const body = JSON.parse(response.body);
      expect(body.error.data.required_scopes).toEqual([
        "read",
        "write",
        "admin",
      ]);
    });

    it("should not include WWW-Authenticate header without OAuth config", () => {
      const middleware = new AuthenticationMiddleware({});
      const response = middleware.getScopeChallengeResponse(["admin"]);

      expect(response.headers["WWW-Authenticate"]).toBeUndefined();
      expect(response.headers["Content-Type"]).toBe("application/json");
    });

    it("should return proper JSON-RPC 2.0 format", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(
        ["read"],
        "Description",
        "req-123",
      );

      const body = JSON.parse(response.body);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe("req-123");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toBe("Description");
      expect(body.error.data).toBeDefined();
    });

    it("should include Content-Type header", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse(["read"]);

      expect(response.headers["Content-Type"]).toBe("application/json");
    });

    it("should handle empty scopes array", () => {
      const middleware = new AuthenticationMiddleware({
        oauth: {
          protectedResource: {
            resource: "https://example.com",
          },
        },
      });
      const response = middleware.getScopeChallengeResponse([]);

      expect(response.headers["WWW-Authenticate"]).toContain('scope=""');
      const body = JSON.parse(response.body);
      expect(body.error.data.required_scopes).toEqual([]);
    });
  });
});
