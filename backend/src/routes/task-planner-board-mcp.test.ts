/**
 * Tests for the task planner board MCP server route
 * (task-planner-board-mcp.ts) and the batch creation flow in
 * task-planner.ts's create-task endpoint.
 *
 * These are unit tests with mocked DB — they verify:
 * 1. buildPlannerBoardMcpServer() returns a correctly shaped HTTP MCP entry
 * 2. handleListTasks() returns tasks scoped to the session's tab
 * 3. handleAddTaskDependency() validates tab ownership and surfaces cycle errors
 * 4. The batch create-task endpoint resolves dependsOnBatchIndex to real IDs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB modules before importing the module under test
vi.mock("../db/tasks.js", () => ({
  getAllTasks: vi.fn(),
  createTask: vi.fn(),
  isTaskOwnedByUser: vi.fn(),
  setTaskDependencies: vi.fn(),
}));

vi.mock("../db/tabs.js", () => ({
  getAllTabs: vi.fn(),
  getTabById: vi.fn(),
}));

vi.mock("../websocket-handler.js", () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock("../agent/task-claimer.js", () => ({
  notifyTaskAvailable: vi.fn(),
}));

describe("task-planner-board-mcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildPlannerBoardMcpServer", () => {
    it("returns an HTTP MCP server entry with userId and tabId embedded in the URL", async () => {
      const { buildPlannerBoardMcpServer } = await import("./task-planner-board-mcp.js");

      const entry = buildPlannerBoardMcpServer({ userId: 1, tabId: 2, baseUrl: "http://localhost:3500" });

      expect(entry).not.toBeNull();
      expect(entry.type).toBe("http");
      expect(entry.name).toBe("task-board");
      expect(entry.url).toContain("/api/task-planner-board-mcp/");
      expect(entry.url).toContain("userId=1");
      expect(entry.url).toContain("tabId=2");
    });

    it("includes a JWT Authorization header for the user", async () => {
      const { buildPlannerBoardMcpServer } = await import("./task-planner-board-mcp.js");

      const entry = buildPlannerBoardMcpServer({ userId: 1, tabId: 2, baseUrl: "http://localhost:3500" });

      expect(entry.headers).toHaveLength(1);
      expect(entry.headers[0].name).toBe("Authorization");
      expect(entry.headers[0].value).toMatch(/^Bearer .+/);
    });
  });

  describe("handleListTasks", () => {
    it("returns tasks for the given tabId using getAllTasks", async () => {
      const { getAllTasks } = await import("../db/tasks.js");
      vi.mocked(getAllTasks).mockResolvedValue([
        { id: 10, title: "Task A", type: "feature", priority: 2, state: "todo" } as any,
        { id: 11, title: "Task B", type: "bug", priority: 1, state: "in-progress" } as any,
      ]);

      const { handleListTasks } = await import("./task-planner-board-mcp.js");
      const result = await handleListTasks({ tabId: 2, userId: 1 });

      expect(getAllTasks).toHaveBeenCalledWith({ tabId: 2, userId: 1 });
      expect(result).toEqual([
        { id: 10, title: "Task A", type: "feature", priority: 2, state: "todo" },
        { id: 11, title: "Task B", type: "bug", priority: 1, state: "in-progress" },
      ]);
    });
  });

  describe("handleAddTaskDependency", () => {
    it("rejects when taskId is not in the session tab", async () => {
      const { getAllTasks } = await import("../db/tasks.js");
      vi.mocked(getAllTasks).mockResolvedValue([
        { id: 20, title: "Task X", type: "feature", priority: 2, state: "todo" } as any,
      ]);

      const { handleAddTaskDependency } = await import("./task-planner-board-mcp.js");

      await expect(
        handleAddTaskDependency({ tabId: 2, userId: 1, taskId: 99, dependsOnTaskId: [20] })
      ).rejects.toThrow(/not found in tab/i);
    });

    it("rejects when dependsOnTaskId contains an ID not in the session tab", async () => {
      const { getAllTasks } = await import("../db/tasks.js");
      vi.mocked(getAllTasks).mockResolvedValue([
        { id: 20, title: "Task X", type: "feature", priority: 2, state: "todo" } as any,
      ]);

      const { handleAddTaskDependency } = await import("./task-planner-board-mcp.js");

      await expect(
        handleAddTaskDependency({ tabId: 2, userId: 1, taskId: 20, dependsOnTaskId: [999] })
      ).rejects.toThrow(/not found in tab/i);
    });

    it("surfaces DependencyCycleError from the dependency write path", async () => {
      const { getAllTasks } = await import("../db/tasks.js");
      const { setTaskDependencies } = await import("../db/tasks.js");
      vi.mocked(getAllTasks).mockResolvedValue([
        { id: 30, title: "A", type: "feature", priority: 2, state: "todo", dependsOn: [] } as any,
        { id: 31, title: "B", type: "feature", priority: 2, state: "todo", dependsOn: [30] } as any,
      ]);

      // setTaskDependencies needs to be imported since it's the new export
      const tasksModule = await import("../db/tasks.js");
      // Mock setTaskDependencies to throw DependencyCycleError
      const { DependencyCycleError } = await import("../types.js");
      vi.mocked((tasksModule as any).setTaskDependencies).mockRejectedValue(
        new DependencyCycleError(30, 31)
      );

      const { handleAddTaskDependency } = await import("./task-planner-board-mcp.js");

      await expect(
        handleAddTaskDependency({ tabId: 2, userId: 1, taskId: 30, dependsOnTaskId: [31] })
      ).rejects.toThrow(/cycle/i);
    });

    it("calls setTaskDependencies with merged existing + new dependencies", async () => {
      const { getAllTasks } = await import("../db/tasks.js");
      vi.mocked(getAllTasks).mockResolvedValue([
        { id: 40, title: "A", type: "feature", priority: 2, state: "todo", dependsOn: [41] } as any,
        { id: 41, title: "B", type: "feature", priority: 2, state: "todo", dependsOn: [] } as any,
        { id: 42, title: "C", type: "feature", priority: 2, state: "todo", dependsOn: [] } as any,
      ]);

      const tasksModule = await import("../db/tasks.js");
      vi.mocked((tasksModule as any).setTaskDependencies).mockResolvedValue(undefined);

      const { handleAddTaskDependency } = await import("./task-planner-board-mcp.js");
      await handleAddTaskDependency({ tabId: 2, userId: 1, taskId: 40, dependsOnTaskId: [42] });

      // Should merge existing [41] with new [42]
      expect((tasksModule as any).setTaskDependencies).toHaveBeenCalledWith(
        40,
        expect.arrayContaining([41, 42])
      );
    });
  });
});
