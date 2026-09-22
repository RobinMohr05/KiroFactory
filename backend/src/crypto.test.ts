/**
 * Tests for crypto.ts — specifically the input validation added to decrypt()
 * so that malformed/corrupt ciphertexts produce clear, diagnosable errors
 * instead of cryptic low-level Node.js crypto failures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scryptSync } from "crypto";
import { encrypt, decrypt } from "./crypto.js";

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    scryptSync: vi.fn(actual.scryptSync),
  };
});

const MIN_HEX_LENGTH = (16 + 16) * 2; // (IV_LENGTH + AUTH_TAG_LENGTH) * 2 = 64

describe("decrypt() input validation", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "test-secret-key-for-unit-tests";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
  });

  it("throws a clear error when passed an empty string", () => {
    expect(() => decrypt("")).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed a non-string (null)", () => {
    expect(() => decrypt(null as unknown as string)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed a non-string (number)", () => {
    expect(() => decrypt(42 as unknown as string)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed a non-hex string", () => {
    // Pad with non-hex chars to minimum length but still invalid
    const nonHex = "Z".repeat(MIN_HEX_LENGTH);
    expect(() => decrypt(nonHex)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed a hex string that is too short", () => {
    // Valid hex chars but below minimum length
    const tooShort = "abcdef12".repeat(3); // 24 chars, well below 64
    expect(() => decrypt(tooShort)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed a hex string that is exactly one char too short", () => {
    const oneShort = "a".repeat(MIN_HEX_LENGTH - 1);
    expect(() => decrypt(oneShort)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("throws a clear error when passed an odd-length hex string", () => {
    // Odd length is invalid hex (each byte = 2 chars)
    const oddLength = "a".repeat(MIN_HEX_LENGTH + 1);
    expect(() => decrypt(oddLength)).toThrow(
      /invalid ciphertext/i
    );
  });

  it("does NOT include the ciphertext value in the error message", () => {
    const badInput = "not-hex-at-all";
    let errorMessage = "";
    try {
      decrypt(badInput);
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    expect(errorMessage).not.toContain(badInput);
  });

  it("round-trips a valid encrypted value correctly (regression)", () => {
    const plaintext = "super-secret-value-123";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });
});

describe("key derivation caching", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const scryptMock = vi.mocked(scryptSync);

  beforeEach(() => {
    scryptMock.mockClear();
    process.env.ENCRYPTION_KEY = "cache-test-secret-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
  });

  it("derives the key only once across many encrypt/decrypt calls with the same ENCRYPTION_KEY", () => {
    // First call may derive; subsequent calls with the same key must not re-derive.
    const c1 = encrypt("value-one");
    const c2 = encrypt("value-two");
    decrypt(c1);
    decrypt(c2);

    expect(scryptMock).toHaveBeenCalledTimes(1);
  });

  it("re-derives the key when ENCRYPTION_KEY changes", () => {
    encrypt("value-one");
    const callsAfterFirst = scryptMock.mock.calls.length;

    process.env.ENCRYPTION_KEY = "a-different-secret-key";
    encrypt("value-two");

    expect(scryptMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
