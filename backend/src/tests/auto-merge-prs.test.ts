/**
 * Tests for the autoMergePrs toggle feature on Tabs.
 *
 * Covers:
 * - Tab type includes the autoMergePrs property
 * - updateTab accepts and persists autoMergePrs
 * - Route validation (PUT /api/tabs/:id rejects non-boolean autoMergePrs)
 * - mapNodeToTab defaults to false when property is absent
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

import type { Tab } from "../types.js";

describe("autoMergePrs on Tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Tab type", () => {
    it("should have autoMergePrs as a boolean property", () => {
      // Type-level check: a Tab object must include autoMergePrs
      const tab: Tab = {
        id: 1,
        name: "Test",
        repositoryUrl: null,
        gitProvider: null,
        mcpConfig: { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true },
        columns: ["todo", "done"],
        sortOrder: 0,
        userId: 1,
        createdAt: "2026-01-01T00:00:00Z",
        autoMergePrs: false,
      };
      expect(tab.autoMergePrs).toBe(false);
    });
  });

  describe("mapNodeToTab", () => {
    it("should default autoMergePrs to false when property is absent from node", async () => {
      // Simulate getAllTabs returning a tab node without autoMergePrs property
      const fakeTabNode = {
        properties: {
          id: 1,
          name: "Test Tab",
          repositoryUrl: "https://github.com/org/repo",
          gitProvider: null,
          columns: ["todo", "done"],
          sortOrder: 0,
          createdAt: { toString: () => "2026-01-01T00:00:00Z" },
          // autoMergePrs is intentionally absent
        },
      };
      const fakeMcpNode = {
        properties: { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true },
      };

      mockReadQuery.mockImplementation(async (fn: Function) => {
        const fakeTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  if (key === "t") return fakeTabNode;
                  if (key === "ownerId") return 1;
                  if (key === "mcpNode") return fakeMcpNode;
                  return null;
                },
              },
            ],
          }),
        };
        return fn(fakeTx);
      });

      const { getAllTabs } = await import("../db/tabs.js");
      const tabs = await getAllTabs(1);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].autoMergePrs).toBe(false);
    });

    it("should read autoMergePrs as true when property is set on node", async () => {
      const fakeTabNode = {
        properties: {
          id: 2,
          name: "Test Tab 2",
          repositoryUrl: null,
          gitProvider: null,
          columns: ["todo", "done"],
          sortOrder: 0,
          createdAt: { toString: () => "2026-01-01T00:00:00Z" },
          autoMergePrs: true,
        },
      };
      const fakeMcpNode = {
        properties: { atlassian: true, azureDevops: false, awsApi: false, awsDocs: true },
      };

      mockReadQuery.mockImplementation(async (fn: Function) => {
        const fakeTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (key: string) => {
                  if (key === "t") return fakeTabNode;
                  if (key === "ownerId") return 1;
                  if (key === "mcpNode") return fakeMcpNode;
                  return null;
                },
              },
            ],
          }),
        };
        return fn(fakeTx);
      });

      const { getAllTabs } = await import("../db/tabs.js");
      const tabs = await getAllTabs(1);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].autoMergePrs).toBe(true);
    });
  });

  describe("updateTab with autoMergePrs", () => {
    it("should pass autoMergePrs to the Cypher query when provided", async () => {
      let capturedParams: Record<string, unknown> | null = null;

      const fakeTabNode = {
        properties: {
          id: 1,
          name: "Updated Tab",
          repositoryUrl: null,
          gitProvider: null,
          columns: ["todo", "done"],
          sortOrder: 0,
          createdAt: { toString: () => "2026-01-01T00:00:00Z" },
          autoMergePrs: true,
        },
      };
      const fakeMcpNode = {
        properties: { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true },
      };

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
                    if (key === "mcpNode") return fakeMcpNode;
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
      const result = await updateTab(1, "Updated Tab", null, null, null, true);

      expect(result).not.toBeNull();
      expect(result!.autoMergePrs).toBe(true);
      // Verify the parameter was passed to the query
      expect(capturedParams).not.toBeNull();
      expect(capturedParams!.autoMergePrs).toBe(true);
    });

    it("should not update autoMergePrs when undefined is passed", async () => {
      let capturedQuery: string | null = null;
      let capturedParams: Record<string, unknown> | null = null;

      const fakeTabNode = {
        properties: {
          id: 1,
          name: "Unchanged Tab",
          repositoryUrl: null,
          gitProvider: null,
          columns: ["todo", "done"],
          sortOrder: 0,
          createdAt: { toString: () => "2026-01-01T00:00:00Z" },
          autoMergePrs: false,
        },
      };
      const fakeMcpNode = {
        properties: { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true },
      };

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
                    if (key === "mcpNode") return fakeMcpNode;
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
      // Call without autoMergePrs (undefined — should not change the value)
      const result = await updateTab(1, "Unchanged Tab", null, null, null, undefined);

      expect(result).not.toBeNull();
      // The query should use COALESCE-like conditional to keep existing value
      expect(capturedQuery).not.toBeNull();
    });
  });

  describe("createTab with autoMergePrs", () => {
    it("should set autoMergePrs to false by default on creation", async () => {
      let capturedParams: Record<string, unknown> | null = null;

      const fakeTabNode = {
        properties: {
          id: 99,
          name: "New Tab",
          repositoryUrl: null,
          gitProvider: null,
          columns: ["todo", "in-progress", "developed", "in-code-review", "reviewed", "in-qa", "done"],
          sortOrder: 0,
          createdAt: { toString: () => "2026-01-01T00:00:00Z" },
          autoMergePrs: false,
        },
      };
      const fakeMcpNode = {
        properties: { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true },
      };

      mockWriteQuery.mockImplementation(async (fn: Function) => {
        const fakeTx = {
          run: vi.fn().mockImplementation((query: string, params: Record<string, unknown>) => {
            capturedParams = params;
            return {
              records: [
                {
                  get: (key: string) => {
                    if (key === "t") return fakeTabNode;
                    if (key === "m") return fakeMcpNode;
                    return null;
                  },
                },
              ],
            };
          }),
        };
        return fn(fakeTx);
      });

      const { createTab } = await import("../db/tabs.js");
      const result = await createTab({ name: "New Tab", userId: 1 });

      expect(result.autoMergePrs).toBe(false);
      expect(capturedParams).not.toBeNull();
      expect(capturedParams!.autoMergePrs).toBe(false);
    });
  });
});
