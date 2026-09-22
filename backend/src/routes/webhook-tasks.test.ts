/**
 * Tests for POST /api/webhooks/tasks — webhook endpoint for creating tasks
 * from external systems (Azure DevOps service hooks, generic callers).
 *
 * Uses the supertest + vi.mock pattern established by auth.viewmode.test.ts
 * and other route tests in this codebase.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock db/tasks.js — the createTask function this route calls
vi.mock("../db/tasks.js", () => ({
  createTask: vi.fn(),
}));

// Mock task-claimer.js — notifyTaskAvailable
vi.mock("../agent/task-claimer.js", () => ({
  notifyTaskAvailable: vi.fn(),
}));

// Mock db/tabs.js — getTabById used to validate the target tab exists
vi.mock("../db/tabs.js", () => ({
  getTabById: vi.fn(),
}));

// Mock logger
vi.mock("../logger.js", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

import { createTask } from "../db/tasks.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import { getTabById } from "../db/tabs.js";
import webhookTasksRouter from "./webhook-tasks.js";

const VALID_SECRET = "test-webhook-secret-123";

// A minimal Tab-shaped object for getTabById mock returns.
function fakeTab(id: number) {
  return { id, name: `Tab ${id}`, sortOrder: 0, userId: 1 } as any;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/tasks", webhookTasksRouter);
  return app;
}

describe("POST /api/webhooks/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SECRET = VALID_SECRET;
    process.env.WEBHOOK_DEFAULT_TAB_ID = "2";
    // By default, any tab id resolves to an existing tab.
    vi.mocked(getTabById).mockImplementation(async (id: number) => fakeTab(id));
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_DEFAULT_TAB_ID;
  });

  // ─── Auth: missing/wrong secret ──────────────────────────────────────────

  it("returns 401 when X-Webhook-Secret header is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .send({ title: "Test task" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or missing webhook secret");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Webhook-Secret header is wrong", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", "wrong-secret")
      .send({ title: "Test task" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or missing webhook secret");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Webhook-Secret has a different length than the configured secret", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", "short")
      .send({ title: "Test task" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or missing webhook secret");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 401 (not 500) when configured secret has multibyte UTF-8 chars and header secret has same string length but different byte length", async () => {
    // "café" has string .length === 4 but encodes to 5 UTF-8 bytes.
    // "caff" has string .length === 4 and encodes to 4 UTF-8 bytes.
    // Before the fix: headerSecret.length === webhookSecret.length (4 === 4) passes the
    // string-length guard, then timingSafeEqual throws RangeError (4 vs 5 bytes), which
    // is caught by the outer try/catch and returned as 500 instead of 401.
    process.env.WEBHOOK_SECRET = "café"; // 4 code units, 5 UTF-8 bytes
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", "caff") // 4 code units, 4 UTF-8 bytes — wrong secret
      .send({ title: "Test task" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or missing webhook secret");
    expect(createTask).not.toHaveBeenCalled();
  });

  // ─── Auth: WEBHOOK_SECRET not configured ─────────────────────────────────

  it("returns 503 when WEBHOOK_SECRET env var is not set", async () => {
    delete process.env.WEBHOOK_SECRET;

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Test task" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Webhook endpoint not configured");
    expect(createTask).not.toHaveBeenCalled();
  });

  // ─── ADO payload: Bug ────────────────────────────────────────────────────

  it("creates a bug task from ADO payload with WorkItemType Bug", async () => {
    const createdTask = {
      id: 42,
      title: "Fix login crash",
      type: "bug",
      priority: 2,
      state: "todo",
      description: "<p>Login crashes on Safari</p>",
      files: [],
      origin: "ai",
      tabIds: [2],
      dependsOn: [],
      groupId: null,
      createdAt: "2026-08-31T17:00:00.000Z",
      updatedAt: "2026-08-31T17:00:00.000Z",
    };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({
        resource: {
          fields: {
            "System.Title": "Fix login crash",
            "System.Description": "<p>Login crashes on Safari</p>",
            "Microsoft.VSTS.Common.Priority": 2,
            "System.WorkItemType": "Bug",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdTask);
    expect(createTask).toHaveBeenCalledWith({
      title: "Fix login crash",
      description: "<p>Login crashes on Safari</p>",
      priority: 2,
      type: "bug",
      files: [],
      origin: "ai",
      tabIds: [2],
      dependsOn: [],
      groupId: null,
    });
    expect(notifyTaskAvailable).toHaveBeenCalled();
  });

  // ─── ADO payload: Product Backlog Item → feature ─────────────────────────

  it("creates a feature task from ADO payload with WorkItemType Product Backlog Item", async () => {
    const createdTask = { id: 43, title: "New dashboard", type: "feature" };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({
        resource: {
          fields: {
            "System.Title": "New dashboard",
            "System.WorkItemType": "Product Backlog Item",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ type: "feature" }),
    );
  });

  // ─── ADO payload: unrecognized work item type → improvement ──────────────

  it("creates an improvement task from ADO payload with unrecognized WorkItemType", async () => {
    const createdTask = { id: 44, title: "Spike", type: "improvement" };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({
        resource: {
          fields: {
            "System.Title": "Spike",
            "System.WorkItemType": "Task",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ type: "improvement" }),
    );
  });

  // ─── Generic flat payload → improvement ──────────────────────────────────

  it("creates an improvement task from generic flat payload", async () => {
    const createdTask = { id: 45, title: "Refactor utils", type: "improvement", priority: 2 };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({
        title: "Refactor utils",
        description: "Clean up utility module",
        priority: 2,
      });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith({
      title: "Refactor utils",
      description: "Clean up utility module",
      priority: 2,
      type: "improvement",
      files: [],
      origin: "ai",
      tabIds: [2],
      dependsOn: [],
      groupId: null,
    });
    expect(notifyTaskAvailable).toHaveBeenCalled();
  });

  // ─── Validation: missing title ───────────────────────────────────────────

  it("returns 400 when title is missing", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ description: "No title here", priority: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title is required");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("returns 400 when title is empty string", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "", priority: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("title is required");
    expect(createTask).not.toHaveBeenCalled();
  });

  // ─── Defaults: missing/invalid priority → 3 ─────────────────────────────

  it("defaults priority to 3 when not provided", async () => {
    const createdTask = { id: 46, title: "No prio", priority: 3 };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "No prio" });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 3 }),
    );
  });

  it("defaults priority to 3 when invalid value is provided", async () => {
    const createdTask = { id: 47, title: "Bad prio", priority: 3 };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Bad prio", priority: 99 });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 3 }),
    );
  });

  // ─── Success → 201 with task body, notifyTaskAvailable called ────────────

  it("returns 201 with the created task and calls notifyTaskAvailable", async () => {
    const createdTask = {
      id: 50,
      title: "Webhook task",
      type: "improvement",
      priority: 3,
      state: "todo",
      description: "",
      files: [],
      origin: "ai",
      createdAt: "2026-08-31T17:00:00.000Z",
      updatedAt: "2026-08-31T17:00:00.000Z",
    };
    vi.mocked(createTask).mockResolvedValue(createdTask as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Webhook task" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdTask);
    expect(notifyTaskAvailable).toHaveBeenCalledTimes(1);
  });

  // ─── Error handling: createTask throws → 500 ────────────────────────────

  it("returns 500 when createTask throws an unexpected error", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("DB connection lost"));

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Will fail" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to create task");
  });

  // ─── Error handling: DependencyCycleError → 409 ──────────────────────────

  it("returns 409 when createTask throws DependencyCycleError", async () => {
    // Import the real DependencyCycleError class
    const { DependencyCycleError } = await import("../types.js");
    vi.mocked(createTask).mockRejectedValue(new DependencyCycleError(1, 2));

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Cycle task" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("cycle");
    expect(res.body.fromId).toBe(1);
    expect(res.body.toId).toBe(2);
  });

  // ─── Tab routing: explicit tabId in generic payload ──────────────────────

  it("routes to an explicit tabId provided in a generic flat payload", async () => {
    vi.mocked(createTask).mockResolvedValue({ id: 60 } as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Routed task", tabId: 7 });

    expect(res.status).toBe(201);
    expect(getTabById).toHaveBeenCalledWith(7);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ tabIds: [7] }),
    );
  });

  // ─── Tab routing: explicit tabId in ADO payload fields ───────────────────

  it("routes to an explicit tabId provided in an ADO payload's fields", async () => {
    vi.mocked(createTask).mockResolvedValue({ id: 61 } as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({
        tabId: 9,
        resource: {
          fields: {
            "System.Title": "ADO routed task",
            "System.WorkItemType": "Bug",
          },
        },
      });

    expect(res.status).toBe(201);
    expect(getTabById).toHaveBeenCalledWith(9);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ tabIds: [9] }),
    );
  });

  // ─── Tab routing: env-configurable default when no explicit tabId ────────

  it("falls back to WEBHOOK_DEFAULT_TAB_ID when no tabId is in the payload", async () => {
    process.env.WEBHOOK_DEFAULT_TAB_ID = "5";
    vi.mocked(createTask).mockResolvedValue({ id: 62 } as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Default tab task" });

    expect(res.status).toBe(201);
    expect(getTabById).toHaveBeenCalledWith(5);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ tabIds: [5] }),
    );
  });

  // ─── Tab routing: hardcoded fallback 2 when env var unset ────────────────

  it("falls back to tab 2 when neither payload tabId nor WEBHOOK_DEFAULT_TAB_ID is set", async () => {
    delete process.env.WEBHOOK_DEFAULT_TAB_ID;
    vi.mocked(createTask).mockResolvedValue({ id: 63 } as any);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Legacy default task" });

    expect(res.status).toBe(201);
    expect(getTabById).toHaveBeenCalledWith(2);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ tabIds: [2] }),
    );
  });

  // ─── Tab validation: 400 when tabId is not a valid integer ───────────────

  it("returns 400 when payload tabId is not a valid positive integer", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Bad tab", tabId: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tabId must be a positive integer");
    expect(getTabById).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  // ─── Tab validation: 400 when the target tab does not exist ──────────────

  it("returns 400 when the resolved tab does not exist", async () => {
    vi.mocked(getTabById).mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Orphan task", tabId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Target tab 999 does not exist");
    expect(getTabById).toHaveBeenCalledWith(999);
    expect(createTask).not.toHaveBeenCalled();
  });

  // ─── Tab validation: 500 when WEBHOOK_DEFAULT_TAB_ID is malformed ─────────

  it("returns 500 (server misconfiguration) when WEBHOOK_DEFAULT_TAB_ID is set to a non-integer", async () => {
    // The caller provided a perfectly valid request (no tabId); the bad value
    // came from the server's own env var. This is an operator-facing config
    // error, not a caller payload error, so it must surface as 5xx — never 400.
    process.env.WEBHOOK_DEFAULT_TAB_ID = "abc";
    const app = createApp();
    const res = await request(app)
      .post("/api/webhooks/tasks")
      .set("X-Webhook-Secret", VALID_SECRET)
      .send({ title: "Bad default" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      "Server misconfiguration: WEBHOOK_DEFAULT_TAB_ID is not a valid positive integer",
    );
    expect(getTabById).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});
