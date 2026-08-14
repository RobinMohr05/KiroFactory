/**
 * Planner Session Pool — Maintains a pool of pre-warmed KiroRunner processes
 * for near-instant AI Task Planner startup.
 *
 * Processes are keyed by tabId. Each checkout delivers a brand-new ACP session
 * (via newSession()) so there is zero context carryover between conversations.
 * Idle processes are reaped after a configurable timeout.
 */

import { log, toErrorFields } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface a pooled runner must satisfy.
 * In production this is a KiroRunner; in tests it's a mock.
 */
export interface PooledRunner {
  /** Unique identifier for this runner within the pool */
  id: string;
  /** Whether the underlying kiro-cli process is still alive */
  isAlive: boolean;
  /** Start a fresh ACP session (discards prior conversation) */
  newSession: (overrideCwd?: string) => Promise<void>;
  /** Shut down the process */
  close: () => Promise<void>;
}

export type RunnerFactory = () => Promise<PooledRunner>;

export interface PlannerSessionPoolOptions {
  /** Max idle + checked-out runners per tab */
  maxPerTab: number;
  /** Max total runners across all tabs */
  maxTotal: number;
  /** How long an idle runner is kept before being reaped (ms) */
  idleTimeoutMs: number;
  /** Factory to create a new PooledRunner */
  factory: RunnerFactory;
}

// ---------------------------------------------------------------------------
// Internal slot state
// ---------------------------------------------------------------------------

interface PoolSlot {
  runner: PooledRunner;
  tabId: number;
  /** Whether this slot is currently checked out (in-use) */
  inUse: boolean;
  /** Timestamp when the slot last became idle (for reaping) */
  idleSince: number;
}

// ---------------------------------------------------------------------------
// Pool implementation
// ---------------------------------------------------------------------------

export class PlannerSessionPool {
  private readonly opts: PlannerSessionPoolOptions;
  private readonly slots = new Map<string, PoolSlot>(); // runnerId → slot
  private readonly reaperInterval: ReturnType<typeof setInterval> | null = null;
  /** Track in-flight warm operations to avoid duplicate concurrent spawns */
  private readonly warmingInProgress = new Set<number>(); // tabId

  constructor(opts: PlannerSessionPoolOptions) {
    this.opts = opts;
    // Start periodic reaper (every idleTimeoutMs / 2, min 5s)
    const reaperMs = Math.max(5000, Math.floor(opts.idleTimeoutMs / 2));
    this.reaperInterval = setInterval(() => this.reapIdle(), reaperMs);
    // Unref so it doesn't keep the process alive
    if (this.reaperInterval && typeof this.reaperInterval.unref === "function") {
      this.reaperInterval.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ensure at least one idle slot exists for the given tab.
   * If one already exists, this is a no-op.
   * If the pool is full (per-tab or total), does nothing.
   * Never throws — failures are logged and swallowed.
   */
  async warm(tabId: number): Promise<void> {
    // Already have an idle slot for this tab?
    if (this.idleCount(tabId) > 0) return;

    // Per-tab cap check (idle + in-use)
    if (this.tabCount(tabId) >= this.opts.maxPerTab) return;

    // Total cap check
    if (this.slots.size >= this.opts.maxTotal) return;

    // Already warming for this tab? Avoid duplicate concurrent spawns.
    if (this.warmingInProgress.has(tabId)) return;

    this.warmingInProgress.add(tabId);
    try {
      const runner = await this.opts.factory();
      // Double-check caps haven't been exceeded while we awaited
      if (this.tabCount(tabId) >= this.opts.maxPerTab || this.slots.size >= this.opts.maxTotal) {
        // Pool filled up while we were spawning — close and discard
        await runner.close().catch(() => {});
        return;
      }
      this.slots.set(runner.id, {
        runner,
        tabId,
        inUse: false,
        idleSince: Date.now(),
      });
      log.info("pool-slot-created", {
        component: "planner-pool",
        tabId,
        runnerId: runner.id,
        totalSlots: this.slots.size,
        msg: `Warmed planner pool slot for tab ${tabId}`,
      });
    } catch (err) {
      log.warn("pool-warm-failed", {
        component: "planner-pool",
        tabId,
        ...toErrorFields(err),
        msg: `Failed to warm planner pool slot for tab ${tabId}`,
      });
    } finally {
      this.warmingInProgress.delete(tabId);
    }
  }

  /**
   * Check out an idle runner for the given tab.
   * Returns null if no idle runner is available (caller should cold-start).
   * The returned runner is marked as in-use and must be released or destroyed.
   */
  checkout(tabId: number): PooledRunner | null {
    for (const [id, slot] of this.slots) {
      if (slot.tabId === tabId && !slot.inUse) {
        // Verify the runner is still alive
        if (!slot.runner.isAlive) {
          // Dead runner — remove from pool silently
          this.slots.delete(id);
          continue;
        }
        slot.inUse = true;
        log.info("pool-slot-checkout", {
          component: "planner-pool",
          tabId,
          runnerId: id,
          msg: `Checked out planner pool slot for tab ${tabId}`,
        });
        return slot.runner;
      }
    }
    return null;
  }

  /**
   * Return a runner to the pool (mark as idle again).
   * If the runner is dead, it is removed from the pool instead.
   */
  release(runnerId: string): void {
    const slot = this.slots.get(runnerId);
    if (!slot) return;

    if (!slot.runner.isAlive) {
      this.slots.delete(runnerId);
      log.info("pool-slot-removed-dead", {
        component: "planner-pool",
        runnerId,
        tabId: slot.tabId,
        msg: `Removed dead runner from pool on release`,
      });
      return;
    }

    slot.inUse = false;
    slot.idleSince = Date.now();
    log.info("pool-slot-released", {
      component: "planner-pool",
      runnerId,
      tabId: slot.tabId,
      msg: `Released planner pool slot back to idle`,
    });
  }

  /**
   * Permanently remove a runner from the pool and close it.
   * Used when a conversation ends and the runner should not be reused.
   */
  async destroy(runnerId: string): Promise<void> {
    const slot = this.slots.get(runnerId);
    if (!slot) return;
    this.slots.delete(runnerId);
    try {
      await slot.runner.close();
    } catch {
      /* best effort */
    }
    log.info("pool-slot-destroyed", {
      component: "planner-pool",
      runnerId,
      tabId: slot.tabId,
      msg: `Destroyed planner pool slot`,
    });
  }

  /**
   * Remove a runner from the pool WITHOUT closing it.
   * Used when ownership of the runner is being transferred to another subsystem
   * (e.g., injecting it into a session). The caller takes responsibility for
   * eventually closing the runner.
   */
  detach(runnerId: string): void {
    const slot = this.slots.get(runnerId);
    if (!slot) return;
    this.slots.delete(runnerId);
    log.info("pool-slot-detached", {
      component: "planner-pool",
      runnerId,
      tabId: slot.tabId,
      msg: `Detached planner pool slot (ownership transferred)`,
    });
  }

  /**
   * Reap idle slots that have exceeded idleTimeoutMs.
   * Called periodically by the internal interval and exposed for testing.
   */
  reapIdle(): void {
    const now = Date.now();
    const toReap: string[] = [];

    for (const [id, slot] of this.slots) {
      if (!slot.inUse && (now - slot.idleSince) > this.opts.idleTimeoutMs) {
        toReap.push(id);
      }
    }

    for (const id of toReap) {
      const slot = this.slots.get(id)!;
      this.slots.delete(id);
      slot.runner.close().catch(() => {});
      log.info("pool-slot-reaped", {
        component: "planner-pool",
        runnerId: id,
        tabId: slot.tabId,
        idleMs: now - slot.idleSince,
        msg: `Reaped idle planner pool slot after ${now - slot.idleSince}ms`,
      });
    }
  }

  /**
   * Shut down the pool: close all runners and clear the pool.
   */
  async shutdown(): Promise<void> {
    if (this.reaperInterval) clearInterval(this.reaperInterval);

    const closePromises: Promise<void>[] = [];
    for (const [, slot] of this.slots) {
      closePromises.push(slot.runner.close().catch(() => {}));
    }
    await Promise.all(closePromises);
    this.slots.clear();
  }

  // -------------------------------------------------------------------------
  // Introspection (for tests and monitoring)
  // -------------------------------------------------------------------------

  /** Number of idle slots for a specific tab */
  idleCount(tabId: number): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.tabId === tabId && !slot.inUse) count++;
    }
    return count;
  }

  /** Total number of slots (idle + in-use) across all tabs */
  totalCount(): number {
    return this.slots.size;
  }

  /** Total slots (idle + in-use) for a specific tab */
  private tabCount(tabId: number): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.tabId === tabId) count++;
    }
    return count;
  }

  /**
   * @internal — exposed for testing only.
   * Returns the idle slots for a tab. Do not use in production code.
   */
  _getIdleSlots(tabId: number): PoolSlot[] {
    const result: PoolSlot[] = [];
    for (const slot of this.slots.values()) {
      if (slot.tabId === tabId && !slot.inUse) result.push(slot);
    }
    return result;
  }
}
