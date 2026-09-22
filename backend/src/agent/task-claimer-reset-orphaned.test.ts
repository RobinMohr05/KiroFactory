/**
 * Unit tests for resetOrphanedTasks() (task-claimer.ts) — the startup-time
 * crash-recovery sweep that resets tasks whose session died mid-turn back to
 * "todo".
 *
 * Regression coverage for the runaway-spawn incident's root-cause writeup
 * (knowledge-base/knowledge/autoscaler-session-zombie-state-bug.md): before
 * this fix, resetOrphanedTasks() hardcoded WHERE t.state = 'in-progress',
 * so a task orphaned mid-review ("in-code-review") or mid-QA ("in-qa") was
 * never recovered even by a full server restart — only a task orphaned
 * mid-development was. The fix derives the full set of working states from
 * every seeded :Agent's workingState instead of hardcoding one string.
 *
 * Follows the mock-the-DB convention used by autoscaler-manager.test.ts /
 * idle-loop-task-visibility-fixes.test.ts — no real Neo4j connection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();

vi.mock("../db/connection.js", () => ({
  readQuery: vi.fn(async (fn: any) => fn({ run: runMock })),
  writeQuery: vi.fn(async (fn: any) => fn({ run: runMock })),
}));

vi.mock("../db/agents.js", () => ({
  getAllAgents: vi.fn(),
}));

vi.mock("../db/tasks.js", () => ({
  getTaskById: vi.fn(),
  getTasksByBranch: vi.fn(),
  getTasksByGroupId: vi.fn(),
}));

import { resetOrphanedTasks } from "./task-claimer.js";
import { getAllAgents } from "../db/agents.js";

function makeAgent(workingState: string) {
  return {
    id: 1,
    name: `agent-${workingState}`,
    kind: "editor" as const,
    claimState: "todo",
    workingState,
    resolveState: "done",
    requiresTask: true,
  } as any;
}

describe("resetOrphanedTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockResolvedValue({ records: [{ get: () => 3 }] });
  });

  it("resets tasks across every distinct workingState found across all seeded agents, not just 'in-progress'", async () => {
    vi.mocked(getAllAgents).mockResolvedValue([
      makeAgent("in-progress"),
      makeAgent("in-code-review"),
      makeAgent("in-qa"),
    ]);

    await resetOrphanedTasks();

    expect(runMock).toHaveBeenCalledTimes(1);
    const [, params] = runMock.mock.calls[0];
    expect(params.workingStates).toEqual(
      expect.arrayContaining(["in-progress", "in-code-review", "in-qa"])
    );
    expect(params.workingStates).toHaveLength(3);
  });

  it("de-duplicates workingState values shared by multiple agents", async () => {
    vi.mocked(getAllAgents).mockResolvedValue([
      makeAgent("in-progress"),
      makeAgent("in-progress"), // e.g. a second developer-agent-like stage
    ]);

    await resetOrphanedTasks();

    const [, params] = runMock.mock.calls[0];
    expect(params.workingStates).toEqual(["in-progress"]);
  });

  it("falls back to the single hardcoded 'in-progress' state if the agent lookup fails", async () => {
    vi.mocked(getAllAgents).mockRejectedValue(new Error("DB unreachable"));

    await resetOrphanedTasks();

    const [, params] = runMock.mock.calls[0];
    expect(params.workingStates).toEqual(["in-progress"]);
  });

  it("falls back to 'in-progress' if getAllAgents resolves with an empty list", async () => {
    vi.mocked(getAllAgents).mockResolvedValue([]);

    await resetOrphanedTasks();

    const [, params] = runMock.mock.calls[0];
    expect(params.workingStates).toEqual(["in-progress"]);
  });

  it("returns the reset count reported by the write query", async () => {
    vi.mocked(getAllAgents).mockResolvedValue([makeAgent("in-progress")]);
    runMock.mockResolvedValue({ records: [{ get: () => 7 }] });

    const count = await resetOrphanedTasks();

    expect(count).toBe(7);
  });
});
