/**
 * Regression tests for task #1973:
 * PUT /api/tabs/:id silently wipes repositoryUrl when the field is omitted.
 *
 * updateTab() must treat an omitted (undefined) repositoryUrl as "keep the
 * existing value" — mirroring how autoMergePrs and gitProvider are handled —
 * rather than unconditionally overwriting the stored URL with null.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB connection layer
const mockWriteQuery = vi.fn();
const mockReadQuery = vi.fn();
vi.mock("../db/connection.js", () => ({
  readQuery: (fn: unknown) => mockReadQuery(fn),
  writeQuery: (fn: unknown) => mockWriteQuery(fn),
  isDbAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock("../db/id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(99),
}));

vi.mock("../session-manager.js", () => ({
  getAllSessions: vi.fn().mockReturnValue([]),
}));

vi.mock("../error-store.js", () => ({
  getAllErrors: vi.fn().mockReturnValue([]),
}));

function makeTabNode(props: Record<string, unknown>) {
  return {
    properties: {
      id: 1,
      name: "Tab",
      repositoryUrl: "https://github.com/org/repo",
      gitProvider: null,
      columns: ["todo", "done"],
      sortOrder: 0,
      createdAt: { toString: () => "2026-01-01T00:00:00Z" },
      autoMergePrs: false,
      ...props,
    },
  };
}

describe("updateTab repositoryUrl preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should NOT overwrite repositoryUrl when undefined is passed (partial update)", async () => {
    let capturedQuery: string | null = null;
    let capturedParams: Record<string, unknown> | null = null;

    const fakeTabNode = makeTabNode({ name: "Renamed Tab" });

    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const fakeTx = {
        run: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
          capturedQuery = query;
          capturedParams = params;
          return {
            records: [
              {
                get: (key: string) => {
                  if (key === "t") return fakeTabNode;
                  if (key === "ownerId") return 1;
                  return null;
                },
              },
            ],
          };
        }),
      };
      return fn(fakeTx);
    });

    const { updateTab } = await import("../db/tabs.js");
    // Only the name is being changed; repositoryUrl is omitted (undefined).
    await updateTab(1, "Renamed Tab", undefined, null, undefined);

    expect(capturedQuery).not.toBeNull();
    expect(capturedParams).not.toBeNull();
    // The query must guard the repositoryUrl write so an omitted value does
    // not touch the property — signalled by a hasRepositoryUrl flag.
    expect(capturedParams!.hasRepositoryUrl).toBe(false);
    // And the unconditional SET must be gone.
    expect(capturedQuery).not.toContain("SET t.repositoryUrl = $repositoryUrl,");
    expect(capturedQuery).not.toMatch(/SET[^]*t\.repositoryUrl = \$repositoryUrl(?![^]*FOREACH)/);
  });

  it("should update repositoryUrl when an explicit value is provided", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    const fakeTabNode = makeTabNode({ repositoryUrl: "https://github.com/org/new" });

    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const fakeTx = {
        run: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            records: [
              {
                get: (key: string) => {
                  if (key === "t") return fakeTabNode;
                  if (key === "ownerId") return 1;
                  return null;
                },
              },
            ],
          };
        }),
      };
      return fn(fakeTx);
    });

    const { updateTab } = await import("../db/tabs.js");
    await updateTab(1, "Tab", "https://github.com/org/new", null, undefined);

    expect(capturedParams).not.toBeNull();
    expect(capturedParams!.hasRepositoryUrl).toBe(true);
    expect(capturedParams!.repositoryUrl).toBe("https://github.com/org/new");
  });

  it("should clear repositoryUrl when null is explicitly provided", async () => {
    let capturedParams: Record<string, unknown> | null = null;

    const fakeTabNode = makeTabNode({ repositoryUrl: null });

    mockWriteQuery.mockImplementation(async (fn: Function) => {
      const fakeTx = {
        run: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            records: [
              {
                get: (key: string) => {
                  if (key === "t") return fakeTabNode;
                  if (key === "ownerId") return 1;
                  return null;
                },
              },
            ],
          };
        }),
      };
      return fn(fakeTx);
    });

    const { updateTab } = await import("../db/tabs.js");
    await updateTab(1, "Tab", null, null, undefined);

    expect(capturedParams).not.toBeNull();
    expect(capturedParams!.hasRepositoryUrl).toBe(true);
    expect(capturedParams!.repositoryUrl).toBeNull();
  });
});
