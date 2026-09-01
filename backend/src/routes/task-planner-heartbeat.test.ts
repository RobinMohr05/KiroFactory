/**
 * Tests for the presence heartbeat endpoint in task-planner.ts.
 *
 * Verifies:
 * - active=true triggers plannerPool.warm() for the effective tab
 * - active=false triggers plannerPool.drainTab() for the effective tab
 * - When the pool is disabled (no KIRO_API_KEY), neither warm nor drainTab
 *   is called, and the route still responds 202 { ok: true }
 * - drainTab never destroys an in-use (checked-out) slot
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

// Shared mock pool instance so the test can inspect calls.
const mockPool = {
  warm: vi.fn().mockResolvedValue(undefined),
  drainTab: vi.fn().mockResolvedValue(undefined),
  checkout: vi.fn().mockReturnValue(null),
  detach: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../planner-session-pool.js", () => {
  class MockPool {
    warm = mockPool.warm;
    drainTab = mockPool.drainTab;
    checkout = mockPool.checkout;
    detach = mockPool.detach;
    destroy = mockPool.destroy;
    shutdown = mockPool.shutdown;
  }
  return { PlannerSessionPool: MockPool };
});

vi.mock("../db/tasks.js", () => ({ createTask: vi.fn(), getAllTasks: vi.fn().mockResolvedValue([]) }));
vi.mock("../db/tabs.js", () => ({
  getAllTabs: vi.fn().mockResolvedValue([]),
  getTabById: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/users.js", () => ({ getUserById: vi.fn().mockResolvedValue({ id: 1 }) }));
vi.mock("../db/credentials.js", () => ({ getDecryptedCredential: vi.fn().mockResolvedValue(null) }));
vi.mock("../websocket-handler.js", () => ({ broadcastToUser: vi.fn() }));
vi.mock("../agent/task-claimer.js", () => ({ notifyTaskAvailable: vi.fn() }));
vi.mock("./task-planner-board-mcp.js", () => ({ buildPlannerBoardMcpServer: vi.fn().mockReturnValue({}) }));
vi.mock("../session-manager.js", () => ({
  createSession: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSessionOutput: vi.fn(),
  sendPrompt: vi.fn(),
  getAllSessions: vi.fn().mockReturnValue([]),
  injectPendingRunner: vi.fn().mockReturnValue(false),
}));
vi.mock("../error-store.js", () => ({ recordError: vi.fn() }));
vi.mock("../agent/kiro-runner.js", () => ({ KiroRunner: { create: vi.fn() } }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getUserId: () => 1,
}));
vi.mock("../logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: vi.fn().mockReturnValue({}),
}));

const originalApiKey = process.env.KIRO_API_KEY;

async function buildApp(): Promise<express.Express> {
  const { default: taskPlannerRouter } = await import("./task-planner.js");
  const app = express();
  app.use(express.json());
  app.use("/api/task-planner", taskPlannerRouter);
  return app;
}

describe("POST /api/task-planner/heartbeat", () => {
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.KIRO_API_KEY = originalApiKey;
    else delete process.env.KIRO_API_KEY;
  });

  describe("pool enabled", () => {
    let app: express.Express;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      process.env.KIRO_API_KEY = "test-key";
      app = await buildApp();
    });

    it("warms the pool for the tab when active=true", async () => {
      await supertest(app)
        .post("/api/task-planner/heartbeat")
        .send({ tabId: 7, active: true })
        .expect(202, { ok: true });

      expect(mockPool.warm).toHaveBeenCalledWith(7);
      expect(mockPool.drainTab).not.toHaveBeenCalled();
    });

    it("drains the tab when active=false", async () => {
      await supertest(app)
        .post("/api/task-planner/heartbeat")
        .send({ tabId: 7, active: false })
        .expect(202, { ok: true });

      expect(mockPool.drainTab).toHaveBeenCalledWith(7);
      expect(mockPool.warm).not.toHaveBeenCalled();
    });

    it("falls back to tabId 0 when tabId is omitted", async () => {
      await supertest(app)
        .post("/api/task-planner/heartbeat")
        .send({ active: true })
        .expect(202, { ok: true });

      expect(mockPool.warm).toHaveBeenCalledWith(0);
    });
  });

  describe("pool disabled", () => {
    let app: express.Express;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      delete process.env.KIRO_API_KEY;
      app = await buildApp();
    });

    it("short-circuits with 202 without touching the pool (active=true)", async () => {
      await supertest(app)
        .post("/api/task-planner/heartbeat")
        .send({ tabId: 7, active: true })
        .expect(202, { ok: true });

      expect(mockPool.warm).not.toHaveBeenCalled();
      expect(mockPool.drainTab).not.toHaveBeenCalled();
    });

    it("short-circuits with 202 without touching the pool (active=false)", async () => {
      await supertest(app)
        .post("/api/task-planner/heartbeat")
        .send({ tabId: 7, active: false })
        .expect(202, { ok: true });

      expect(mockPool.warm).not.toHaveBeenCalled();
      expect(mockPool.drainTab).not.toHaveBeenCalled();
    });
  });
});

describe("PlannerSessionPool.drainTab — never destroys an in-use slot", () => {
  it("leaves a checked-out runner alive while destroying idle ones", async () => {
    vi.resetModules();
    vi.doUnmock("../planner-session-pool.js");
    const actual = (await vi.importActual<
      typeof import("../planner-session-pool.js")
    >("../planner-session-pool.js"));
    const { PlannerSessionPool } = actual;
    type PooledRunner = import("../planner-session-pool.js").PooledRunner;

    let seq = 0;
    const factory = () => {
      seq++;
      return Promise.resolve({
        id: `r-${seq}`,
        isAlive: true,
        newSession: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as PooledRunner);
    };

    const pool = new PlannerSessionPool({
      maxPerTab: 3,
      maxTotal: 5,
      idleTimeoutMs: 60_000,
      factory,
    });

    await pool.warm(1);
    const inUse = pool.checkout(1); // check one out
    await pool.warm(1); // create a fresh idle slot
    expect(inUse).not.toBeNull();
    expect(pool.idleCount(1)).toBe(1);

    await pool.drainTab(1);

    // Idle slot destroyed, in-use survives
    expect(pool.idleCount(1)).toBe(0);
    expect(pool.totalCount()).toBe(1);
    expect(inUse!.close).not.toHaveBeenCalled();

    await pool.shutdown();
  });
});
