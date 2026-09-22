/**
 * Tests for the shared config module — specifically that JWT_SECRET is
 * validated at access time and fails fast with a clear error rather than
 * silently falling back to a hardcoded literal.
 *
 * Pattern mirrors crypto.ts's treatment of ENCRYPTION_KEY: both secrets
 * must be explicitly set; neither tolerates a "dev fallback" that is
 * committed to the repo and therefore public knowledge.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("getJwtSecret", () => {
  const originalEnv = process.env.JWT_SECRET;

  afterEach(() => {
    // Restore original value (or delete it)
    if (originalEnv !== undefined) {
      process.env.JWT_SECRET = originalEnv;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it("returns the JWT_SECRET env var when it is set", async () => {
    process.env.JWT_SECRET = "test-secret-value-for-testing";
    const { getJwtSecret } = await import("./config.js");
    expect(getJwtSecret()).toBe("test-secret-value-for-testing");
  });

  it("throws when JWT_SECRET is not set", async () => {
    delete process.env.JWT_SECRET;
    const { getJwtSecret } = await import("./config.js");
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
  });

  it("throws when JWT_SECRET is an empty string", async () => {
    process.env.JWT_SECRET = "";
    const { getJwtSecret } = await import("./config.js");
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
  });
});
