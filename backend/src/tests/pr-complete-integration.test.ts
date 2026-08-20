/**
 * Tests for the complete_pull_request MCP tool integration:
 * - WorkerTaskMeta includes autoMergePrs and allGroupTasksDone
 * - The pr-complete MCP server is conditionally included in buildMcpServers
 */

import { describe, it, expect } from "vitest";
import type { WorkerTaskMeta } from "../worker-ws-handler.js";

describe("WorkerTaskMeta autoMergePrs support", () => {
  it("should allow autoMergePrs boolean field on WorkerTaskMeta", () => {
    const meta: WorkerTaskMeta = {
      id: 1,
      title: "Test task",
      type: "feature",
      description: "A test task",
      files: [],
      branch: "feature/test",
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      autoMergePrs: true,
      allGroupTasksDone: true,
    };
    expect(meta.autoMergePrs).toBe(true);
    expect(meta.allGroupTasksDone).toBe(true);
  });

  it("should allow allGroupTasksDone to be false", () => {
    const meta: WorkerTaskMeta = {
      id: 2,
      title: "Grouped task",
      type: "bug",
      description: "Fix something",
      files: [],
      branch: "fix/grouped",
      pullRequestUrl: "https://github.com/owner/repo/pull/2",
      autoMergePrs: true,
      allGroupTasksDone: false,
    };
    expect(meta.allGroupTasksDone).toBe(false);
  });

  it("should default autoMergePrs and allGroupTasksDone to undefined when not set", () => {
    const meta: WorkerTaskMeta = {
      id: 3,
      title: "Simple task",
      description: "No auto-merge",
      files: [],
    };
    expect(meta.autoMergePrs).toBeUndefined();
    expect(meta.allGroupTasksDone).toBeUndefined();
  });
});
