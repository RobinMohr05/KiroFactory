/**
 * Tests for Cross-Site WebSocket Hijacking (CSWSH) protection on the /ws
 * client WebSocket endpoint (task #2006).
 *
 * Browsers automatically attach cookies to cross-origin WebSocket handshake
 * requests. Without Origin validation, a malicious page can open
 * wss://<host>/ws and authenticate as the victim using their cookie — granting
 * full read + control of the victim's account data.
 *
 * The fix validates `req.headers.origin` in the upgrade handler:
 *  - In production: same-origin only (origin must match the `Host` header, or
 *    `PUBLIC_URL` if configured).
 *  - In development: all origins allowed (mirrors the existing CORS behavior).
 *
 * Tests verify the `isOriginAllowed` utility exported from
 * websocket-handler.ts by injecting different environments, keeping the test
 * hermetic without needing a live server.
 */

import { describe, it, expect } from "vitest";
import { isOriginAllowed } from "../websocket-handler.js";

// ---------------------------------------------------------------------------
// Development mode: all origins allowed
// ---------------------------------------------------------------------------

describe("isOriginAllowed — development mode", () => {
  const devEnv = { NODE_ENV: "development" };

  it("allows any origin in development", () => {
    expect(isOriginAllowed("https://evil.example.com", "myapp.example.com", devEnv)).toBe(true);
  });

  it("allows localhost in development", () => {
    expect(isOriginAllowed("http://localhost:3500", "myapp.example.com", devEnv)).toBe(true);
  });

  it("allows a missing/undefined origin in development", () => {
    expect(isOriginAllowed(undefined, "myapp.example.com", devEnv)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Production mode: same-origin only (derived from Host header)
// ---------------------------------------------------------------------------

describe("isOriginAllowed — production mode, no PUBLIC_URL", () => {
  const prodEnv = { NODE_ENV: "production" };

  it("allows an origin that matches the Host header (http)", () => {
    expect(isOriginAllowed("http://myapp.example.com", "myapp.example.com", prodEnv)).toBe(true);
  });

  it("allows an origin that matches the Host header (https)", () => {
    expect(isOriginAllowed("https://myapp.example.com", "myapp.example.com", prodEnv)).toBe(true);
  });

  it("allows an origin matching Host with a non-default port", () => {
    // e.g. local dev server on port 3500 — the port is non-default so it stays
    // in both Origin and Host.
    expect(isOriginAllowed("http://myapp.example.com:3500", "myapp.example.com:3500", prodEnv)).toBe(true);
  });

  it("rejects an origin from a different host in production", () => {
    expect(isOriginAllowed("https://evil.example.com", "myapp.example.com", prodEnv)).toBe(false);
  });

  it("rejects a subdomain that doesn't match the Host header", () => {
    expect(isOriginAllowed("https://sub.myapp.example.com", "myapp.example.com", prodEnv)).toBe(false);
  });

  it("rejects a missing/undefined origin in production", () => {
    // Requests without an Origin header (non-browser) should also be rejected in production
    // so only browser same-origin connections are accepted.
    expect(isOriginAllowed(undefined, "myapp.example.com", prodEnv)).toBe(false);
  });

  it("rejects an empty-string origin in production", () => {
    expect(isOriginAllowed("", "myapp.example.com", prodEnv)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Production mode: PUBLIC_URL override
// ---------------------------------------------------------------------------

describe("isOriginAllowed — production mode, PUBLIC_URL configured", () => {
  const prodEnvWithPublicUrl = {
    NODE_ENV: "production",
    PUBLIC_URL: "https://app.mycompany.com",
  };

  it("allows the PUBLIC_URL origin when it matches", () => {
    // Internal host may differ from public hostname (e.g. ACA internal URL vs. custom domain)
    expect(
      isOriginAllowed("https://app.mycompany.com", "someinternal.azurecontainerapps.io", prodEnvWithPublicUrl)
    ).toBe(true);
  });

  it("also allows the Host-based same-origin when PUBLIC_URL is set", () => {
    expect(
      isOriginAllowed("https://someinternal.azurecontainerapps.io", "someinternal.azurecontainerapps.io", prodEnvWithPublicUrl)
    ).toBe(true);
  });

  it("rejects an unrelated origin even when PUBLIC_URL is set", () => {
    expect(
      isOriginAllowed("https://evil.example.com", "someinternal.azurecontainerapps.io", prodEnvWithPublicUrl)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("isOriginAllowed — edge cases", () => {
  const prodEnv = { NODE_ENV: "production" };

  it("handles a Host header with a port in production", () => {
    expect(isOriginAllowed("http://localhost:3500", "localhost:3500", prodEnv)).toBe(true);
  });

  it("rejects an origin with a different port from the Host header", () => {
    expect(isOriginAllowed("http://localhost:9999", "localhost:3500", prodEnv)).toBe(false);
  });

  it("handles an undefined host (falls back to no allowed same-origin)", () => {
    // Without a Host header, same-origin derivation is impossible; reject.
    expect(isOriginAllowed("https://some.origin", undefined, prodEnv)).toBe(false);
  });
});
