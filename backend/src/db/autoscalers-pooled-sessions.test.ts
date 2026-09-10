/**
 * Tests for the pooled-session ownership helpers in db/autoscalers.ts
 * (task #1680): the (:AutoScaler)-[:OWNS_SESSION]->(:Session) edge that
 * durably links an AutoScaler to its worker session pool.
 *
 * Follows the same mocked-connection pattern as db/turns.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

import { readQuery, writeQuery } from "./connection.js";
import {
  linkPooledSession,
  unlinkPooledSession,
  touchPooledSession,
  getPooledSessionIds,
  getPooledSessionsWithLastUsed,
  getAllPooledSessionIds,
} from "./autoscalers.js";

describe("db/autoscalers — pooled session ownership (OWNS_SESSION)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("linkPooledSession", () => {
    it("MERGEs an OWNS_SESSION edge between the AutoScaler and the session", async () => {
      const runMock = vi.fn().mockResolvedValue({ records: [] });
      (writeQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      await linkPooledSession(1, 42);

      expect(writeQuery).toHaveBeenCalledOnce();
      expect(runMock).toHaveBeenCalledOnce();
      const [query, params] = runMock.mock.calls[0];
      expect(query).toContain("MERGE (f)-[r:OWNS_SESSION]->(s)");
      expect(params).toEqual({ autoScalerId: 1, sessionId: 42 });
    });
  });

  describe("unlinkPooledSession", () => {
    it("deletes the OWNS_SESSION edge between the AutoScaler and the session", async () => {
      const runMock = vi.fn().mockResolvedValue({ records: [] });
      (writeQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      await unlinkPooledSession(1, 42);

      expect(runMock).toHaveBeenCalledOnce();
      const [query, params] = runMock.mock.calls[0];
      expect(query).toContain("OWNS_SESSION");
      expect(query).toContain("DELETE r");
      expect(params).toEqual({ autoScalerId: 1, sessionId: 42 });
    });
  });

  describe("touchPooledSession", () => {
    it("updates lastUsedAt on the existing edge", async () => {
      const runMock = vi.fn().mockResolvedValue({ records: [] });
      (writeQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      await touchPooledSession(1, 42);

      const [query, params] = runMock.mock.calls[0];
      expect(query).toContain("SET r.lastUsedAt = datetime()");
      expect(params).toEqual({ autoScalerId: 1, sessionId: 42 });
    });
  });

  describe("getPooledSessionIds", () => {
    it("returns the session IDs linked to the AutoScaler via OWNS_SESSION", async () => {
      const runMock = vi.fn().mockResolvedValue({
        records: [
          { get: (key: string) => (key === "sessionId" ? 201 : undefined) },
          { get: (key: string) => (key === "sessionId" ? 202 : undefined) },
        ],
      });
      (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      const result = await getPooledSessionIds(1);

      expect(result).toEqual([201, 202]);
      const [query, params] = runMock.mock.calls[0];
      expect(query).toContain("OWNS_SESSION");
      expect(params).toEqual({ autoScalerId: 1 });
    });

    it("returns an empty array when the AutoScaler has no pooled sessions", async () => {
      const runMock = vi.fn().mockResolvedValue({ records: [] });
      (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      const result = await getPooledSessionIds(1);

      expect(result).toEqual([]);
    });
  });

  describe("getPooledSessionsWithLastUsed", () => {
    it("returns session IDs paired with each edge's lastUsedAt", async () => {
      const runMock = vi.fn().mockResolvedValue({
        records: [
          {
            get: (key: string) => {
              const data: Record<string, unknown> = {
                sessionId: 201,
                lastUsedAt: { toString: () => "2026-09-10T00:00:00.000Z" },
              };
              return data[key];
            },
          },
        ],
      });
      (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      const result = await getPooledSessionsWithLastUsed(1);

      expect(result).toEqual([{ sessionId: 201, lastUsedAt: "2026-09-10T00:00:00.000Z" }]);
    });
  });

  describe("getAllPooledSessionIds", () => {
    it("returns pooled session IDs across all AutoScalers", async () => {
      const runMock = vi.fn().mockResolvedValue({
        records: [
          { get: (key: string) => (key === "sessionId" ? 42 : undefined) },
        ],
      });
      (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

      const result = await getAllPooledSessionIds();

      expect(result).toEqual([42]);
      const [query] = runMock.mock.calls[0];
      expect(query).toContain("MATCH (:AutoScaler)-[:OWNS_SESSION]->(s:Session)");
    });
  });
});
