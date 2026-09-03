/**
 * Tests for the Planner Session Pool.
 *
 * Covers:
 * - Creating (warming) a slot for a tab
 * - Checking out an idle slot
 * - Returning a slot to the pool
 * - Reaping idle slots after timeout
 * - Per-tab and total size caps
 * - Concurrency isolation: two checkouts from same tab get separate runners
 * - Pool-enabled guard (requires server-level KIRO_API_KEY)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll test the pool with a mock KiroRunner so we don't need kiro-cli installed.
// The pool should accept a factory function for creating runners.

import { PlannerSessionPool, type PooledRunner } from "./planner-session-pool.js";

describe("PlannerSessionPool", () => {
  let pool: PlannerSessionPool;
  let mockRunnerCount: number;

  // Factory that creates mock runners
  function mockRunnerFactory(): Promise<PooledRunner> {
    mockRunnerCount++;
    const id = mockRunnerCount;
    return Promise.resolve({
      id: `runner-${id}`,
      isAlive: true,
      newSession: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
  }

  beforeEach(() => {
    mockRunnerCount = 0;
    pool = new PlannerSessionPool({
      maxPerTab: 3,
      maxTotal: 5,
      idleTimeoutMs: 1000, // 1 second for tests
      factory: mockRunnerFactory,
    });
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe("warm (ensure idle slot)", () => {
    it("creates an idle slot for a tab when none exists", async () => {
      await pool.warm(1);
      expect(pool.idleCount(1)).toBe(1);
      expect(pool.totalCount()).toBe(1);
    });

    it("does not create a second slot if one already exists and is idle", async () => {
      await pool.warm(1);
      await pool.warm(1);
      expect(pool.idleCount(1)).toBe(1);
    });

    it("creates a new idle slot if all existing ones for the tab are checked out", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(runner).not.toBeNull();
      // Now all slots are checked out, warm should create another
      await pool.warm(1);
      expect(pool.idleCount(1)).toBe(1);
    });

    it("does not exceed maxPerTab", async () => {
      // Check out 3 runners to fill up the per-tab cap
      await pool.warm(1);
      await pool.checkout(1);
      await pool.warm(1);
      await pool.checkout(1);
      await pool.warm(1);
      await pool.checkout(1);
      // Now 3 checked out, 0 idle — warm should NOT create a 4th
      await pool.warm(1);
      expect(pool.idleCount(1)).toBe(0);
      // total for tab 1 = 3 (all checked out)
    });

    it("does not exceed maxTotal across tabs", async () => {
      // Fill pool with 5 runners across tabs
      for (let tabId = 1; tabId <= 5; tabId++) {
        await pool.warm(tabId);
      }
      expect(pool.totalCount()).toBe(5);
      // Warming a 6th tab should not create a new slot
      await pool.warm(6);
      expect(pool.totalCount()).toBe(5);
      expect(pool.idleCount(6)).toBe(0);
    });
  });

  describe("checkout", () => {
    it("returns an idle runner for the requested tab", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(runner).not.toBeNull();
      expect(runner!.id).toBe("runner-1");
    });

    it("returns null when no idle runner exists for the tab", async () => {
      await pool.warm(2);
      const runner = await pool.checkout(1); // different tab
      expect(runner).toBeNull();
    });

    it("marks the slot as in-use so it cannot be checked out again", async () => {
      await pool.warm(1);
      const r1 = await pool.checkout(1);
      const r2 = await pool.checkout(1);
      expect(r1).not.toBeNull();
      expect(r2).toBeNull();
    });

    it("does not return a dead runner", async () => {
      await pool.warm(1);
      // Simulate runner dying
      const slots = pool._getIdleSlots(1);
      slots[0].runner.isAlive = false;
      const runner = await pool.checkout(1);
      expect(runner).toBeNull();
    });

    it("two concurrent checkouts on the same tab get separate runners", async () => {
      await pool.warm(1);
      await pool.warm(1); // force second slot since first is idle — won't dup
      // Manually create a second slot
      await pool.checkout(1); // take the first
      await pool.warm(1); // now creates a second since none idle
      // Return the first
      const slots = pool._getIdleSlots(1);
      expect(slots.length).toBe(1);

      // Now checkout the remaining idle
      const r = await pool.checkout(1);
      expect(r).not.toBeNull();
    });
  });

  describe("release (return to pool)", () => {
    it("makes the runner available for checkout again after release", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(runner).not.toBeNull();
      expect(pool.idleCount(1)).toBe(0);

      pool.release(runner!.id);
      expect(pool.idleCount(1)).toBe(1);

      // Can check out again
      const r2 = await pool.checkout(1);
      expect(r2).not.toBeNull();
      expect(r2!.id).toBe(runner!.id);
    });

    it("does not re-add a dead runner on release", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      runner!.isAlive = false;
      pool.release(runner!.id);
      expect(pool.idleCount(1)).toBe(0);
    });
  });

  describe("destroy (discard a runner)", () => {
    it("removes the slot from the pool entirely", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(pool.totalCount()).toBe(1);
      await pool.destroy(runner!.id);
      expect(pool.totalCount()).toBe(0);
    });

    it("calls close() on the runner", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      await pool.destroy(runner!.id);
      expect(runner!.close).toHaveBeenCalled();
    });
  });

  describe("detach (transfer ownership without closing)", () => {
    it("removes the slot from the pool entirely", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(pool.totalCount()).toBe(1);
      pool.detach(runner!.id);
      expect(pool.totalCount()).toBe(0);
    });

    it("does NOT call close() on the runner", async () => {
      await pool.warm(1);
      const runner = await pool.checkout(1);
      pool.detach(runner!.id);
      expect(runner!.close).not.toHaveBeenCalled();
    });
  });

  describe("idle reaping", () => {
    it("reaps an idle slot after idleTimeoutMs", async () => {
      vi.useFakeTimers();
      pool = new PlannerSessionPool({
        maxPerTab: 3,
        maxTotal: 5,
        idleTimeoutMs: 1000,
        factory: mockRunnerFactory,
      });

      await pool.warm(1);
      expect(pool.idleCount(1)).toBe(1);

      // Advance time past the idle timeout
      vi.advanceTimersByTime(1100);

      // Trigger a reap cycle
      pool.reapIdle();
      expect(pool.idleCount(1)).toBe(0);
      expect(pool.totalCount()).toBe(0);

      vi.useRealTimers();
    });

    it("does not reap a recently-released slot", async () => {
      vi.useFakeTimers();
      pool = new PlannerSessionPool({
        maxPerTab: 3,
        maxTotal: 5,
        idleTimeoutMs: 1000,
        factory: mockRunnerFactory,
      });

      await pool.warm(1);
      // Advance 500ms — not yet timed out
      vi.advanceTimersByTime(500);
      pool.reapIdle();
      expect(pool.idleCount(1)).toBe(1);

      vi.useRealTimers();
    });

    it("does not reap checked-out (in-use) slots", async () => {
      vi.useFakeTimers();
      pool = new PlannerSessionPool({
        maxPerTab: 3,
        maxTotal: 5,
        idleTimeoutMs: 1000,
        factory: mockRunnerFactory,
      });

      await pool.warm(1);
      const runner = await pool.checkout(1);
      expect(runner).not.toBeNull();

      // Advance past timeout
      vi.advanceTimersByTime(2000);
      pool.reapIdle();

      // The checked-out slot should still exist
      expect(pool.totalCount()).toBe(1);

      vi.useRealTimers();
    });
  });

  describe("shutdown", () => {
    it("closes all runners (idle and checked-out)", async () => {
      await pool.warm(1);
      await pool.warm(2);
      const r = await pool.checkout(1);

      await pool.shutdown();

      expect(pool.totalCount()).toBe(0);
      expect(r!.close).toHaveBeenCalled();
    });
  });

  describe("drainTab (immediate on-demand drain)", () => {
    it("destroys all idle slots for the given tab", async () => {
      await pool.warm(1);
      await pool.checkout(1); // occupy the first slot so warm creates a second idle one
      await pool.warm(1);
      const idleBefore = pool._getIdleSlots(1);
      expect(idleBefore.length).toBe(1);
      const idleRunner = idleBefore[0].runner;

      await pool.drainTab(1);

      expect(pool.idleCount(1)).toBe(0);
      expect(idleRunner.close).toHaveBeenCalled();
    });

    it("does NOT destroy in-use (checked-out) slots", async () => {
      await pool.warm(1);
      const inUse = await pool.checkout(1);
      expect(inUse).not.toBeNull();

      await pool.drainTab(1);

      // The checked-out slot survives the drain
      expect(pool.totalCount()).toBe(1);
      expect(inUse!.close).not.toHaveBeenCalled();
    });

    it("leaves other tabs' idle slots untouched", async () => {
      await pool.warm(1);
      await pool.warm(2);
      expect(pool.idleCount(1)).toBe(1);
      expect(pool.idleCount(2)).toBe(1);

      await pool.drainTab(1);

      expect(pool.idleCount(1)).toBe(0);
      expect(pool.idleCount(2)).toBe(1);
    });

    it("is a no-op when the tab has no idle slots", async () => {
      await pool.warm(1);
      const inUse = await pool.checkout(1);
      expect(pool.idleCount(1)).toBe(0);

      await expect(pool.drainTab(1)).resolves.toBeUndefined();

      expect(pool.totalCount()).toBe(1);
      expect(inUse!.close).not.toHaveBeenCalled();
    });
  });
});

describe("isPoolEnabled", () => {
  // Dynamically import to test the env-var guard from the route module
  const originalEnv = process.env.KIRO_API_KEY;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.KIRO_API_KEY = originalEnv;
    } else {
      delete process.env.KIRO_API_KEY;
    }
  });

  it("returns true when KIRO_API_KEY is set", async () => {
    process.env.KIRO_API_KEY = "test-key-123";
    // Import the function fresh — it reads env at call time, not import time
    const { isPoolEnabled } = await import("./routes/task-planner.js");
    expect(isPoolEnabled()).toBe(true);
  });

  it("returns false when KIRO_API_KEY is not set", async () => {
    delete process.env.KIRO_API_KEY;
    const { isPoolEnabled } = await import("./routes/task-planner.js");
    expect(isPoolEnabled()).toBe(false);
  });

  it("returns false when KIRO_API_KEY is empty string", async () => {
    process.env.KIRO_API_KEY = "";
    const { isPoolEnabled } = await import("./routes/task-planner.js");
    expect(isPoolEnabled()).toBe(false);
  });
});

describe("resolvePlannerModel", () => {
  // System-managed default: pin the planner to claude-sonnet-4.6 (the tier just
  // below sonnet-5) when available, falling back down the sonnet chain, then
  // Auto (null) only if none are present.
  it("chooses claude-sonnet-4.6 when it is in the detected list", async () => {
    const { resolvePlannerModel } = await import("./routes/task-planner.js");
    expect(
      resolvePlannerModel([
        "claude-sonnet-4",
        "claude-sonnet-4.5",
        "claude-sonnet-4.6",
        "claude-opus-5",
      ])
    ).toBe("claude-sonnet-4.6");
  });

  it("falls back to claude-sonnet-4.5 when 4.6 is absent", async () => {
    const { resolvePlannerModel } = await import("./routes/task-planner.js");
    expect(
      resolvePlannerModel(["claude-sonnet-4", "claude-sonnet-4.5", "claude-opus-5"])
    ).toBe("claude-sonnet-4.5");
  });

  it("falls back to claude-sonnet-4 when 4.6 and 4.5 are absent", async () => {
    const { resolvePlannerModel } = await import("./routes/task-planner.js");
    expect(resolvePlannerModel(["claude-sonnet-4", "claude-opus-5"])).toBe(
      "claude-sonnet-4"
    );
  });

  it("returns null (Auto) when no sonnet tier is available", async () => {
    const { resolvePlannerModel } = await import("./routes/task-planner.js");
    expect(resolvePlannerModel(["claude-opus-5", "gpt-4o"])).toBeNull();
  });

  it("returns null (Auto) when the detected list is empty", async () => {
    const { resolvePlannerModel } = await import("./routes/task-planner.js");
    expect(resolvePlannerModel([])).toBeNull();
  });
});
