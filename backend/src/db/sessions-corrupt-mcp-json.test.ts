/**
 * Tests for db/sessions.ts's mapRecordToSession() defensive parsing of the
 * per-entry `rawMcpServersJson` strings (task #2016).
 *
 * A single corrupt/unparseable stored JSON string must NOT throw out of the
 * mapper (and thus crash the whole enclosing query — session list routes,
 * boot-time pool rehydration, etc.). It should degrade gracefully, matching
 * the try/catch fallback semantics already used in db/agents.ts's mapToAgent.
 *
 * Follows the same mocked-connection pattern as sessions-pooled-exclusion.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

import { readQuery } from "./connection.js";
import { getSessionFromDb } from "./sessions.js";

/** Builds a fake Neo4j record whose .get(key) returns the given field map. */
function fakeRecord(fields: Record<string, unknown>) {
  return {
    get: (key: string) => fields[key],
  };
}

/** Minimal valid `props` map for a Session row. */
function baseProps() {
  return {
    id: 1,
    name: "s1",
    agent: "dev",
    status: "idle",
    prompt: "",
    interactive: false,
    loop: false,
    runs: 0,
    intervalSeconds: 0,
    cwd: "/workspace",
    timeoutSeconds: 0,
    createdAt: { toString: () => "2026-01-01T00:00:00Z" },
    sortOrder: 0,
  };
}

describe("db/sessions — mapRecordToSession corrupt rawMcpServersJson handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not throw when a stored rawMcpServersJson entry is malformed", async () => {
    const record = fakeRecord({
      props: baseProps(),
      ownerId: 1,
      tabIds: [],
      mcpServersRaw: [],
      rawMcpServersJson: ["not-valid-json"],
    });
    const runMock = vi.fn().mockResolvedValue({ records: [record] });
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    await expect(getSessionFromDb(1)).resolves.not.toThrow;
    const session = await getSessionFromDb(1);
    // Corrupt-only input yields no raw servers rather than crashing.
    expect(session?.rawMcpServers).toBeUndefined();
  });

  it("keeps the valid entries and skips only the corrupt one", async () => {
    const record = fakeRecord({
      props: baseProps(),
      ownerId: 1,
      tabIds: [],
      mcpServersRaw: [],
      rawMcpServersJson: ['{"name":"ok"}', "broken{", '{"name":"ok2"}'],
    });
    const runMock = vi.fn().mockResolvedValue({ records: [record] });
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    const session = await getSessionFromDb(1);
    expect(session?.rawMcpServers).toEqual([{ name: "ok" }, { name: "ok2" }]);
  });

  it("still parses well-formed entries normally", async () => {
    const record = fakeRecord({
      props: baseProps(),
      ownerId: 1,
      tabIds: [],
      mcpServersRaw: [],
      rawMcpServersJson: ['{"name":"a"}', '{"name":"b"}'],
    });
    const runMock = vi.fn().mockResolvedValue({ records: [record] });
    (readQuery as any).mockImplementation(async (fn: any) => fn({ run: runMock }));

    const session = await getSessionFromDb(1);
    expect(session?.rawMcpServers).toEqual([{ name: "a" }, { name: "b" }]);
  });
});
