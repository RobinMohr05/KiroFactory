/**
 * Tests for verifyPassword's timing-side-channel hardening (db/users.ts).
 *
 * Task #1967: when no user matches the email, verifyPassword must still perform
 * a bcrypt.compare against a dummy hash so that the response time is
 * independent of whether the email exists (user-enumeration defense, OWASP A07).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB connection module
vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

// Mock the id-counter module (imported transitively by users.ts)
vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

// Spy on bcrypt.compare while keeping the real implementation.
vi.mock("bcrypt", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("bcrypt");
  return {
    default: {
      ...actual,
      compare: vi.fn((...args: Parameters<typeof actual.compare>) =>
        (actual.compare as any)(...args)
      ),
    },
  };
});

import { readQuery } from "./connection.js";
import bcrypt from "bcrypt";
import { verifyPassword } from "./users.js";

describe("verifyPassword timing hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still calls bcrypt.compare when no user matches the email", async () => {
    // Simulate no matching user: the query returns zero records.
    (readQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({ records: [] }),
      };
      return fn(mockTx);
    });

    const result = await verifyPassword("nobody@example.com", "hunter2");

    expect(result).toBeNull();
    // The whole point of the fix: bcrypt work happens regardless of existence.
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });

  it("returns null for a wrong password on an existing user", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 12);
    (readQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: () => ({
                properties: {
                  id: 1,
                  email: "someone@example.com",
                  passwordHash,
                  uiViewMode: "easy",
                  createdAt: { toString: () => "2026-01-01T00:00:00.000Z" },
                  updatedAt: { toString: () => "2026-01-01T00:00:00.000Z" },
                },
              }),
            },
          ],
        }),
      };
      return fn(mockTx);
    });

    const result = await verifyPassword("someone@example.com", "wrong");

    expect(result).toBeNull();
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });

  it("returns the user for a correct password", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 12);
    (readQuery as any).mockImplementation(async (fn: any) => {
      const mockTx = {
        run: vi.fn().mockResolvedValue({
          records: [
            {
              get: () => ({
                properties: {
                  id: 1,
                  email: "someone@example.com",
                  passwordHash,
                  uiViewMode: "easy",
                  createdAt: { toString: () => "2026-01-01T00:00:00.000Z" },
                  updatedAt: { toString: () => "2026-01-01T00:00:00.000Z" },
                },
              }),
            },
          ],
        }),
      };
      return fn(mockTx);
    });

    const result = await verifyPassword("someone@example.com", "correct-horse");

    expect(result).not.toBeNull();
    expect(result?.email).toBe("someone@example.com");
  });
});
