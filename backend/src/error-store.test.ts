/**
 * Tests for error-store.ts's recordError() — specifically the diagnostic
 * enrichment fields (stack, recentOutput, turn stats) added so agent errors
 * carry enough context to actually diagnose what the agent was doing when
 * the failure happened, instead of just a bare message string.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordError, getAllErrors, clearErrors, type RecordErrorInput } from "./error-store.js";

vi.mock("./websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

const baseInput: RecordErrorInput = {
  sessionId: 1,
  sessionName: "Test Session",
  agent: "developer-agent",
  message: "Worker disconnected",
  context: 'Error while executing task "Fix bug" (ID: 42, type: bug, priority: P2)',
  taskId: 42,
  taskTitle: "Fix bug",
  userId: 1,
};

describe("recordError diagnostic enrichment", () => {
  beforeEach(() => {
    clearErrors();
  });

  it("stores a plain error with no enrichment fields when none are provided (baseline, unchanged behavior)", () => {
    const err = recordError(baseInput);
    expect(err.message).toBe("Worker disconnected");
    expect(err.stack).toBeUndefined();
    expect(err.recentOutput).toBeUndefined();
    expect(err.turnNumber).toBeUndefined();
  });

  it("attaches a stack trace when provided", () => {
    const err = recordError({
      ...baseInput,
      stack: "Error: Worker disconnected\n    at streamPromptAca (session-manager.ts:3300)",
    });
    expect(err.stack).toContain("at streamPromptAca");
  });

  it("attaches a trailing snippet of recent session output", () => {
    const recentOutput = [
      { timestamp: "2026-08-28T18:24:04.000Z", stream: "system" as const, text: "Starting kiro-cli acp --agent developer-agent" },
      { timestamp: "2026-08-28T18:24:06.000Z", stream: "system" as const, text: "kiro-cli ACP initialized — creating session..." },
      { timestamp: "2026-08-28T18:24:18.000Z", stream: "stderr" as const, text: "kiro-cli exited (code: null, signal: SIGTERM)" },
    ];
    const err = recordError({ ...baseInput, recentOutput });
    expect(err.recentOutput).toHaveLength(3);
    expect(err.recentOutput?.[2].text).toContain("SIGTERM");
  });

  it("attaches turn-level stats (turn number, tool call count, duration)", () => {
    const err = recordError({
      ...baseInput,
      turnNumber: 3,
      toolCallCount: 5,
      turnDurationMs: 12_500,
    });
    expect(err.turnNumber).toBe(3);
    expect(err.toolCallCount).toBe(5);
    expect(err.turnDurationMs).toBe(12_500);
  });

  it("persists all enrichment fields together on the stored error, retrievable via getAllErrors", () => {
    recordError({
      ...baseInput,
      stack: "Error: boom\n    at foo (bar.ts:1)",
      recentOutput: [{ timestamp: "2026-08-28T18:24:18.000Z", stream: "stderr", text: "kiro-cli exited (code: null, signal: SIGTERM)" }],
      turnNumber: 1,
      toolCallCount: 0,
      turnDurationMs: 2_000,
    });

    const [stored] = getAllErrors();
    expect(stored.stack).toContain("at foo");
    expect(stored.recentOutput).toHaveLength(1);
    expect(stored.turnNumber).toBe(1);
    expect(stored.toolCallCount).toBe(0);
    expect(stored.turnDurationMs).toBe(2_000);
  });
});
