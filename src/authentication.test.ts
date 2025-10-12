import { IncomingMessage } from "http";
import { describe, expect, it } from "vitest";

import { AuthenticationMiddleware } from "./authentication.js";

describe("AuthenticationMiddleware", () => {
  const createMockRequest = (headers: Record<string, string> = {}): IncomingMessage => {
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
      expect(body.error.message).toBe("Unauthorized: Invalid or missing API key");
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
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
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
        'Bearer resource_metadata="https://example.com//.well-known/oauth-protected-resource"',
      );
    });

    it("should not include WWW-Authenticate header when OAuth config is empty", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {},
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBeUndefined();
    });

    it("should not include WWW-Authenticate header when protectedResource is empty", () => {
      const middleware = new AuthenticationMiddleware({
        apiKey: "test",
        oauth: {
          protectedResource: {},
        },
      });
      const response = middleware.getUnauthorizedResponse();

      expect(response.headers["WWW-Authenticate"]).toBeUndefined();
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
        'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
      );
    });
  });
});