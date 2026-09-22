/**
 * Tests for secret resolution/validation in config.ts.
 *
 * The JWT signing/verification secret must never silently fall back to a
 * committed literal in production (that would let anyone forge a session
 * token). These tests pin the fail-fast behavior: in production a missing/empty
 * JWT_SECRET must throw at resolve time, while in dev/test a fallback is allowed
 * so the local dev server and the test suite keep working without extra setup.
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolveJwtSecret, getJwtSecret } from "./config.js";

describe("resolveJwtSecret", () => {
  it("returns the configured secret when JWT_SECRET is set", () => {
    const secret = resolveJwtSecret({ JWT_SECRET: "my-real-secret", NODE_ENV: "production" });
    expect(secret).toBe("my-real-secret");
  });

  it("returns the configured secret in development too", () => {
    const secret = resolveJwtSecret({ JWT_SECRET: "my-real-secret", NODE_ENV: "development" });
    expect(secret).toBe("my-real-secret");
  });

  it("throws in production when JWT_SECRET is unset", () => {
    expect(() => resolveJwtSecret({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });

  it("throws in production when JWT_SECRET is empty", () => {
    expect(() => resolveJwtSecret({ JWT_SECRET: "", NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });

  it("throws in production when JWT_SECRET is only whitespace", () => {
    expect(() => resolveJwtSecret({ JWT_SECRET: "   ", NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });

  it("falls back to a dev secret when unset outside production", () => {
    const secret = resolveJwtSecret({ NODE_ENV: "development" });
    expect(secret).toBeTruthy();
    expect(typeof secret).toBe("string");
  });

  it("falls back to a dev secret when NODE_ENV is undefined (local/test)", () => {
    const secret = resolveJwtSecret({});
    expect(secret).toBeTruthy();
    expect(typeof secret).toBe("string");
  });
});

describe("getJwtSecret", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it("reads process.env at call time, not at module-load time", () => {
    // Simulates dotenv populating process.env AFTER config.ts was first imported.
    // A lazy getter must reflect the value set now, proving it did not capture
    // an eager module-load-time snapshot (which would ignore a .env-configured
    // JWT_SECRET and silently keep the dev fallback).
    process.env.JWT_SECRET = "loaded-after-import-secret";
    expect(getJwtSecret()).toBe("loaded-after-import-secret");

    // And a subsequent change is picked up too — confirming it re-reads each call.
    process.env.JWT_SECRET = "changed-again-secret";
    expect(getJwtSecret()).toBe("changed-again-secret");
  });

  it("returns a non-empty string when JWT_SECRET is unset outside production", () => {
    delete process.env.JWT_SECRET;
    const secret = getJwtSecret();
    expect(secret).toBeTruthy();
    expect(typeof secret).toBe("string");
  });
});
