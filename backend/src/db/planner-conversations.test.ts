/**
 * Tests for the planner-conversations DB module (db/planner-conversations.ts).
 *
 * Covers:
 *   - shortDescription derivation + truncation + image-marker sanitization
 *   - createPlannerConversation / appendPlannerMessage Cypher wiring
 *   - list ordering (newest first)
 *   - ownership enforcement on get/delete
 *   - deleteExpiredPlannerConversations cutoff semantics
 *
 * Neo4j is mocked the same way db/turns.test.ts mocks it — no live AuraDB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB connection module
vi.mock("./connection.js", () => ({
  readQuery: vi.fn(),
  writeQuery: vi.fn(),
}));

// Mock the id-counter module
vi.mock("./id-counter.js", () => ({
  getNextId: vi.fn().mockResolvedValue(100),
}));

import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";
import {
  createPlannerConversation,
  appendPlannerMessage,
  listPlannerConversations,
  getPlannerConversation,
  deletePlannerConversation,
  deleteExpiredPlannerConversations,
  derivePlannerShortDescription,
  sanitizePlannerMessageText,
} from "./planner-conversations.js";

describe("db/planner-conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getNextId as any).mockResolvedValue(100);
  });

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  describe("derivePlannerShortDescription", () => {
    it("uses the first user message, trimmed", () => {
      expect(derivePlannerShortDescription("  Add a login page  ")).toBe("Add a login page");
    });

    it("truncates to 60 chars and appends an ellipsis", () => {
      const long = "a".repeat(80);
      const result = derivePlannerShortDescription(long);
      // 60 chars + "…"
      expect(result).toBe("a".repeat(60) + "…");
      expect(result.length).toBe(61);
    });

    it("does not truncate a message exactly 60 chars long", () => {
      const exact = "b".repeat(60);
      const result = derivePlannerShortDescription(exact);
      expect(result).toBe(exact);
      expect(result.endsWith("…")).toBe(false);
    });

    it("falls back to 'Untitled planning session' when empty", () => {
      expect(derivePlannerShortDescription("")).toBe("Untitled planning session");
      expect(derivePlannerShortDescription("    ")).toBe("Untitled planning session");
    });
  });

  describe("sanitizePlannerMessageText", () => {
    it("returns plain text unchanged when no images", () => {
      expect(sanitizePlannerMessageText("hello world", undefined)).toBe("hello world");
    });

    it("appends an [image] marker per image and never stores the blob", () => {
      const images = [
        { data: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "image/jpeg" },
      ];
      const result = sanitizePlannerMessageText("look at this", images);
      // The base64 blob data must never appear in the stored text
      expect(result).not.toContain("AAAA");
      expect(result).not.toContain("BBBB");
      // One [image] marker per image
      expect((result.match(/\[image\]/g) || []).length).toBe(2);
      expect(result).toContain("look at this");
    });

    it("produces the marker even when the message text is empty", () => {
      const result = sanitizePlannerMessageText("", [{ data: "X", mimeType: "image/png" }]);
      expect(result).toContain("[image]");
      expect(result).not.toContain("X");
    });
  });

  // ---------------------------------------------------------------------------
  // createPlannerConversation
  // ---------------------------------------------------------------------------

  describe("createPlannerConversation", () => {
    it("allocates an id via getNextId and links the conversation to its owner", async () => {
      let capturedCypher = "";
      let capturedParams: any = null;

      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string, params: any) => {
            capturedCypher = cypher;
            capturedParams = params;
            return {
              records: [
                {
                  get: (key: string) => {
                    const data: Record<string, any> = {
                      id: 100,
                      shortDescription: "Add a login page",
                      createdAt: "2026-09-21T10:00:00.000Z",
                      lastMessageAt: "2026-09-21T10:00:00.000Z",
                    };
                    return data[key];
                  },
                },
              ],
            };
          }),
        };
        return fn(mockTx);
      });

      const result = await createPlannerConversation({
        userId: 1,
        tabId: 2,
        firstUserMessage: "Add a login page",
      });

      expect(getNextId).toHaveBeenCalledWith("PlannerConversation");
      expect(capturedParams).toHaveProperty("id", 100);
      expect(capturedParams).toHaveProperty("shortDescription", "Add a login page");
      // Ownership edge from User
      expect(capturedCypher).toContain(":OWNS");
      expect(capturedCypher).toContain("PlannerConversation");
      expect(result.id).toBe(100);
      expect(result.shortDescription).toBe("Add a login page");
    });

    it("derives a truncated shortDescription from the first user message", async () => {
      let capturedParams: any = null;
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((_c: string, params: any) => {
            capturedParams = params;
            return { records: [{ get: (k: string) => ({ id: 100, shortDescription: params.shortDescription, createdAt: "x", lastMessageAt: "x" } as any)[k] }] };
          }),
        };
        return fn(mockTx);
      });

      await createPlannerConversation({
        userId: 1,
        tabId: null,
        firstUserMessage: "z".repeat(100),
      });

      expect(capturedParams.shortDescription).toBe("z".repeat(60) + "…");
    });
  });

  // ---------------------------------------------------------------------------
  // appendPlannerMessage
  // ---------------------------------------------------------------------------

  describe("appendPlannerMessage", () => {
    it("appends a message at the next position and updates lastMessageAt", async () => {
      let capturedCypher = "";
      let capturedParams: any = null;
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string, params: any) => {
            capturedCypher = cypher;
            capturedParams = params;
            return { records: [{ get: (k: string) => ({ position: 0 } as any)[k] }] };
          }),
        };
        return fn(mockTx);
      });

      await appendPlannerMessage({
        conversationId: 100,
        role: "user",
        text: "hello",
      });

      expect(capturedParams).toHaveProperty("conversationId", 100);
      expect(capturedParams).toHaveProperty("role", "user");
      expect(capturedParams).toHaveProperty("text", "hello");
      expect(capturedCypher).toContain("HAS_MESSAGE");
      expect(capturedCypher).toContain("lastMessageAt");
    });
  });

  // ---------------------------------------------------------------------------
  // listPlannerConversations
  // ---------------------------------------------------------------------------

  describe("listPlannerConversations", () => {
    it("returns conversations for a user, newest first", async () => {
      let capturedCypher = "";
      const rows = [
        { id: 2, shortDescription: "Newer", createdAt: "2026-09-21T12:00:00.000Z", lastMessageAt: "2026-09-21T12:30:00.000Z" },
        { id: 1, shortDescription: "Older", createdAt: "2026-09-20T09:00:00.000Z", lastMessageAt: "2026-09-20T09:10:00.000Z" },
      ];
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string) => {
            capturedCypher = cypher;
            return { records: rows.map((r) => ({ get: (k: string) => (r as any)[k] })) };
          }),
        };
        return fn(mockTx);
      });

      const result = await listPlannerConversations(1);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(2);
      expect(result[1].id).toBe(1);
      // Ordering must be by lastMessageAt DESC (newest first)
      expect(capturedCypher).toContain("ORDER BY");
      expect(capturedCypher).toContain("DESC");
      // Scoped to the owning user
      expect(capturedCypher).toContain(":OWNS");
    });
  });

  // ---------------------------------------------------------------------------
  // getPlannerConversation
  // ---------------------------------------------------------------------------

  describe("getPlannerConversation", () => {
    it("returns the full ordered transcript for an owned conversation", async () => {
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({
            records: [
              {
                get: (k: string) => {
                  const data: Record<string, any> = {
                    id: 100,
                    shortDescription: "Add login",
                    createdAt: "2026-09-21T10:00:00.000Z",
                    lastMessageAt: "2026-09-21T10:05:00.000Z",
                    messages: [
                      { role: "user", text: "Add login", position: 0, createdAt: "2026-09-21T10:00:00.000Z" },
                      { role: "assistant", text: "Sure", position: 1, createdAt: "2026-09-21T10:01:00.000Z" },
                    ],
                  };
                  return data[k];
                },
              },
            ],
          }),
        };
        return fn(mockTx);
      });

      const result = await getPlannerConversation(100, 1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(100);
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].role).toBe("user");
      expect(result!.messages[1].role).toBe("assistant");
    });

    it("enforces ownership — scopes the match to the user (returns null if not owned)", async () => {
      let capturedCypher = "";
      (readQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string) => {
            capturedCypher = cypher;
            return { records: [] };
          }),
        };
        return fn(mockTx);
      });

      const result = await getPlannerConversation(100, 999);
      expect(result).toBeNull();
      expect(capturedCypher).toContain(":OWNS");
    });
  });

  // ---------------------------------------------------------------------------
  // deletePlannerConversation
  // ---------------------------------------------------------------------------

  describe("deletePlannerConversation", () => {
    it("deletes only when owned and reports deletion via count", async () => {
      let capturedCypher = "";
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string) => {
            capturedCypher = cypher;
            return { records: [{ get: (k: string) => (k === "deletedCount" ? 1 : null) }] };
          }),
        };
        return fn(mockTx);
      });

      const ok = await deletePlannerConversation(100, 1);
      expect(ok).toBe(true);
      expect(capturedCypher).toContain(":OWNS");
      expect(capturedCypher).toContain("DETACH DELETE");
    });

    it("returns false when the conversation is not owned by the user", async () => {
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockResolvedValue({ records: [{ get: (k: string) => (k === "deletedCount" ? 0 : null) }] }),
        };
        return fn(mockTx);
      });

      const ok = await deletePlannerConversation(100, 999);
      expect(ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteExpiredPlannerConversations
  // ---------------------------------------------------------------------------

  describe("deleteExpiredPlannerConversations", () => {
    it("deletes only conversations older than the cutoff and DETACH DELETEs their messages", async () => {
      let capturedCypher = "";
      let capturedParams: any = null;
      (writeQuery as any).mockImplementation(async (fn: any) => {
        const mockTx = {
          run: vi.fn().mockImplementation((cypher: string, params: any) => {
            capturedCypher = cypher;
            capturedParams = params;
            return { records: [{ get: (k: string) => (k === "deletedCount" ? 3 : null) }] };
          }),
        };
        return fn(mockTx);
      });

      const cutoff = "2026-09-14T00:00:00.000Z";
      const deleted = await deleteExpiredPlannerConversations(cutoff);

      expect(deleted).toBe(3);
      expect(capturedParams).toHaveProperty("cutoff", cutoff);
      // Must filter by createdAt older than cutoff
      expect(capturedCypher).toContain("createdAt");
      expect(capturedCypher).toContain("<");
      // Must DETACH DELETE conversation + messages
      expect(capturedCypher).toContain("DETACH DELETE");
    });
  });
});
