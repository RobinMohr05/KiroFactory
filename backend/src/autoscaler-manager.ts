/**
 * AutoScaler Manager — auto-scaling session pools (reuse-based model).
 *
 * A "AutoScaler" watches the claimable task queue for a specific agent/tab
 * combination and maintains a pool of loop sessions: some "running" (actively
 * claiming tasks) and some "ready" (created but stopped — no container, no
 * cost, but instantly startable). Sessions are reused via stop/start rather
 * than deleted/recreated on every scale change.
 *
 * TWO COORDINATED BEHAVIORS
 * ─────────────────────────
 * 1. Scale on task arrival: when tasks transition into a claimable state, the
 *    reconcile loop wakes (via waitForTaskAvailable) and starts sessions (reusing
 *    ready ones where possible, creating new ones only when the pool is exhausted).
 *    Routes already call notifyTaskAvailable() on state changes — no extra
 *    wiring needed here.
 *
 * 2. Idle-then-ready (not idle-then-die): sessions are spawned as loop: true.
 *    The autoscaler arms a per-session idle timer: if a session goes
 *    idleTimeoutSeconds without claiming a new task, it is wound down via
 *    stopSession() (tears down its container) but its record is KEPT as a
 *    ready pool member for reuse, rather than deleted.
 *
 * POOL MODEL
 * ──────────
 * Let C = claimable count (getAvailableTaskCount), N = non-done count
 * (getNonDoneTaskCount), cap = maxConcurrency (0 = unlimited/Infinity):
 *
 *   - C > 0: targetRunning = min(cap, C + 1). The "+1" is one eager standby
 *     session to claim the next task as soon as it's needed. Clamped to the
 *     available pool size (running + ready) when creating new sessions.
 *   - C == 0 and N > 0: targetRunning = min(cap, ceil(ceil(N/2)/2));
 *     targetPool (ready + running) = min(cap, ceil(N/2)).
 *   - N == 0: targetRunning = 0; the pool is RETAINED (not deleted) so it's
 *     ready to reuse the next time work shows up.
 *
 * HWM (high-water mark) = the largest target-total-pool size ever observed
 * while this autoscaler has been running. Monotonic non-decreasing, except
 * it is clamped down when maxConcurrency itself decreases. Sessions are
 * created up to the pool target on scale-up; they are never deleted merely
 * to shrink the pool back down toward a lower target — only maxConcurrency
 * decreasing below the current pool size, or the idle-age reaper, deletes a
 * pooled session (see trimPoolForCapDecrease / reapIdlePoolSessions below).
 *
 * Idle-age reaper: any pooled (ready, i.e. non-running) session whose
 * OWNS_SESSION edge lastUsedAt is older than AUTOSCALER_POOL_MAX_IDLE_DAYS
 * (default 7) is deleted (DB node + edge). Runs opportunistically inside
 * reconcile() and on an hourly timer so it fires even while otherwise idle.
 * A currently-running session is never reaped.
 */

import { broadcastToUser } from "./websocket-handler.js";
import {
  createAutoScaler as dbCreateAutoScaler,
  getAutoScalerById,
  getAllAutoScalers as dbGetAllAutoScalers,
  getRunningAutoScalers,
  updateAutoScalerStatus,
  updateAutoScaler as dbUpdateAutoScaler,
  deleteAutoScaler as dbDeleteAutoScaler,
  linkPooledSession,
  touchPooledSession,
  getPooledSessionIds,
  getPooledSessionsWithLastUsed,
} from "./db/autoscalers.js";
import { getAvailableTaskCount, getNonDoneTaskCount, waitForTaskAvailable } from "./agent/task-claimer.js";
import { createSession, startSession, stopSession, deleteSession, getSession, markSessionPooled } from "./session-manager.js";
import { getAgentStageStates } from "./session-manager.js";
import { updateSessionStatus } from "./db/sessions.js";
import { log } from "./logger.js";
import type { AutoScaler, CreateAutoScalerInput, Session } from "./types.js";

/**
 * Idle-age reaper threshold, in days. A pooled (ready) session whose
 * OWNS_SESSION edge lastUsedAt is older than this is deleted outright.
 * Configurable via AUTOSCALER_POOL_MAX_IDLE_DAYS; defaults to 7.
 */
const POOL_MAX_IDLE_DAYS = Number(process.env.AUTOSCALER_POOL_MAX_IDLE_DAYS) || 7;
const POOL_MAX_IDLE_MS = POOL_MAX_IDLE_DAYS * 24 * 60 * 60 * 1000;

/** How often the opportunistic-but-also-timer-driven reaper sweep runs when otherwise idle. */
const REAPER_INTERVAL_MS = 60 * 60 * 1000; // hourly

// ---------------------------------------------------------------------------
// In-memory autoScaler state
// ---------------------------------------------------------------------------

interface ManagedAutoScaler {
  autoScaler: AutoScaler;
  /** Session IDs currently owned by this autoScaler (both running and ready). */
  sessionIds: Set<number>;
  /**
   * High-water mark: the largest target-total-pool size ever observed while
   * this autoscaler has been running. Monotonic non-decreasing except when
   * maxConcurrency itself decreases (see trimPoolForCapDecrease).
   */
  hwm: number;
  /** AbortController for the reconciliation loop. */
  abortController: AbortController;
  /** Whether a reconciliation is currently in progress (prevents re-entrant runs). */
  reconciling: boolean;
  /**
   * Set to true when a reconcile() call is dropped because one is already in progress.
   * The in-progress reconcile checks this in its finally block and triggers a follow-up
   * pass, ensuring no session death or task arrival goes unprocessed for long.
   */
  pendingReconcile: boolean;
  /**
   * Active idle-watcher interval handles started by watchSessionIdle. Stored here so
   * stopAutoScaler can clear them immediately instead of relying on lazy self-cleanup
   * on the next tick. Each watchSessionIdle call registers its handle on creation and
   * removes it when the interval is cleared.
   */
  idleIntervals: Set<ReturnType<typeof setInterval>>;
  /** Hourly reaper timer handle, so stopAutoScaler can clear it immediately. */
  reaperInterval: ReturnType<typeof setInterval> | null;
}

const autoScalers = new Map<number, ManagedAutoScaler>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new AutoScaler (persisted, NOT auto-started).
 */
export async function createAutoScalerRecord(input: CreateAutoScalerInput): Promise<AutoScaler> {
  const autoScaler = await dbCreateAutoScaler(input);
  broadcastToUser(autoScaler.userId, { type: "autoscaler-created", autoScaler });
  return autoScaler;
}

/**
 * Get all AutoScalers for a user.
 */
export async function getAllAutoScalers(userId: number): Promise<AutoScaler[]> {
  return dbGetAllAutoScalers(userId);
}

/**
 * Resume AutoScalers that were running before a server restart.
 *
 * For every AutoScaler persisted with status "running": first reset any of
 * its pooled sessions still marked "running" in the DB back to "stopped"
 * (session-manager.ts's initSessions() already reset the in-memory copy —
 * see its includePooled load — but the DB row itself is only rewritten via
 * an explicit write, which this supplies), then call startAutoScaler(), which
 * adopts the persisted pooled session IDs into managed.sessionIds (all as
 * stopped/ready) and runs one reconcile pass.
 *
 * Must run after initSessions() (session-manager.ts) so the in-memory session
 * store is already populated when reconcile inspects pooled sessions via
 * getSession().
 */
export async function initAutoScalers(): Promise<void> {
  let running: AutoScaler[] = [];
  try {
    running = await getRunningAutoScalers();
  } catch (err) {
    log.warn("autoscaler-restore-failed", {
      component: "autoscaler-manager",
      msg: `Failed to load running AutoScalers from DB: ${err instanceof Error ? err.message : err}`,
    });
    return;
  }

  if (running.length === 0) return;

  log.info("autoscalers-resuming", {
    component: "autoscaler-manager",
    count: running.length,
    msg: `Resuming ${running.length} AutoScaler(s) that were running before restart`,
  });

  for (const autoScaler of running) {
    try {
      const pooledSessionIds = await getPooledSessionIds(autoScaler.id);
      for (const sessionId of pooledSessionIds) {
        try {
          await updateSessionStatus(sessionId, "stopped");
        } catch (err) {
          log.warn("autoscaler-pool-session-reset-error", {
            component: "autoscaler-manager",
            autoScalerId: autoScaler.id,
            sessionId,
            msg: `Failed to reset pooled session status: ${err instanceof Error ? err.message : err}`,
          });
        }
      }

      await startAutoScaler(autoScaler.id);
    } catch (err) {
      log.warn("autoscaler-resume-error", {
        component: "autoscaler-manager",
        autoScalerId: autoScaler.id,
        msg: `Failed to resume AutoScaler: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
}

/**
 * Update an AutoScaler's editable configuration fields. Status is not changeable here.
 * Broadcasts an `autoscaler-updated` event on success.
 */
export async function updateAutoScalerRecord(
  id: number,
  fields: Partial<{
    name: string;
    agentName: string;
    tabIds: number[];
    model: string | null;
    maxConcurrency: number;
    idleTimeoutSeconds: number;
  }>
): Promise<AutoScaler | null> {
  const updated = await dbUpdateAutoScaler(id, fields);
  if (updated) {
    broadcastToUser(updated.userId, { type: "autoscaler-updated", autoScaler: updated });
  }
  return updated;
}

/**
 * Start a AutoScaler — begins reconciliation loop.
 */
export async function startAutoScaler(autoScalerId: number): Promise<AutoScaler | null> {
  const autoScaler = await getAutoScalerById(autoScalerId);
  if (!autoScaler) return null;

  // Already running?
  if (autoScalers.has(autoScalerId)) {
    return autoScaler;
  }

  const updated = await updateAutoScalerStatus(autoScalerId, "running");
  if (!updated) return null;

  const managed: ManagedAutoScaler = {
    autoScaler: updated,
    sessionIds: new Set(),
    hwm: 0,
    abortController: new AbortController(),
    reconciling: false,
    pendingReconcile: false,
    idleIntervals: new Set(),
    reaperInterval: null,
  };

  // Adopt any persisted pooled sessions (from a previous run of this
  // AutoScaler, e.g. before a server restart) so the restarted autoscaler
  // continues managing them rather than losing track and orphaning them.
  try {
    const pooledSessionIds = await getPooledSessionIds(autoScalerId);
    for (const sessionId of pooledSessionIds) {
      managed.sessionIds.add(sessionId);
      markSessionPooled(sessionId);
    }
    // The adopted pool's size is itself a floor for the HWM — it was reached
    // by a prior run of this autoscaler and must not silently shrink on restart.
    managed.hwm = pooledSessionIds.length;
  } catch (err) {
    log.warn("autoscaler-pool-adopt-error", {
      component: "autoscaler-manager",
      autoScalerId,
      msg: `Failed to load persisted pooled sessions: ${err instanceof Error ? err.message : err}`,
    });
  }

  autoScalers.set(autoScalerId, managed);

  broadcastToUser(updated.userId, { type: "autoscaler-updated", autoScaler: updated });

  // Arm the hourly reaper sweep so idle-age deletion fires even while the
  // autoscaler is otherwise quiet (reconcile() also runs it opportunistically).
  managed.reaperInterval = setInterval(() => {
    reapIdlePoolSessions(managed).catch(() => {});
  }, REAPER_INTERVAL_MS);

  // Start the reconciliation loop (non-blocking).
  reconcileLoop(managed).catch((err) => {
    log.warn("autoscaler-reconcile-error", {
      component: "autoscaler-manager",
      autoScalerId,
      msg: `Reconciliation loop crashed: ${err.message || err}`,
    });
  });

  return updated;
}

/**
 * Stop a AutoScaler — stops all owned sessions and marks it stopped.
 */
export async function stopAutoScaler(autoScalerId: number): Promise<AutoScaler | null> {
  const managed = autoScalers.get(autoScalerId);

  // Stop the reconciliation loop.
  if (managed) {
    managed.abortController.abort();

    // Explicitly clear all idle-watcher intervals so they stop immediately
    // rather than relying on lazy self-cleanup on the next tick. Without this,
    // intervals fire one more time (up to 1s later) after abort, which can
    // produce spurious stopSession calls and log entries during teardown.
    for (const handle of managed.idleIntervals) {
      clearInterval(handle);
    }
    managed.idleIntervals.clear();

    if (managed.reaperInterval) {
      clearInterval(managed.reaperInterval);
      managed.reaperInterval = null;
    }

    // Stop (not delete) all owned sessions — they remain in the pool, ready
    // to be reused the next time this autoscaler is started.
    for (const sessionId of managed.sessionIds) {
      try {
        await stopSession(sessionId);
      } catch {
        // best-effort
      }
    }
    managed.sessionIds.clear();
    autoScalers.delete(autoScalerId);
  }

  const updated = await updateAutoScalerStatus(autoScalerId, "stopped");
  if (updated) {
    broadcastToUser(updated.userId, { type: "autoscaler-updated", autoScaler: updated });
  }
  return updated;
}

/**
 * Delete a AutoScaler. Stops it first if running.
 */
export async function deleteAutoScalerRecord(autoScalerId: number): Promise<boolean> {
  // Stop first if running.
  const managed = autoScalers.get(autoScalerId);
  if (managed) {
    await stopAutoScaler(autoScalerId);
  }

  const autoScaler = await getAutoScalerById(autoScalerId);
  const deleted = await dbDeleteAutoScaler(autoScalerId);
  if (deleted && autoScaler) {
    broadcastToUser(autoScaler.userId, { type: "autoscaler-deleted", autoScalerId });
  }
  return deleted;
}

/**
 * Get the running session count for a autoScaler (for UI display).
 * Counts only sessions actually in "running" status — a ready (stopped,
 * pooled) session is not counted here. See getAutoScalerReadySessionCount
 * for the complementary ready-pool count.
 */
export function getAutoScalerRunningSessionCount(autoScalerId: number): number {
  const managed = autoScalers.get(autoScalerId);
  if (!managed) return 0;
  let count = 0;
  for (const sessionId of managed.sessionIds) {
    if (getSession(sessionId)?.status === "running") count++;
  }
  return count;
}

/**
 * Get the ready (pooled, not currently running) session count for a
 * autoScaler — the counterpart to getAutoScalerRunningSessionCount, added
 * for UI parity with the reuse-based pool model. Not currently wired into
 * any route/UI (no frontend work required for this task).
 */
export function getAutoScalerReadySessionCount(autoScalerId: number): number {
  const managed = autoScalers.get(autoScalerId);
  if (!managed) return 0;
  let count = 0;
  for (const sessionId of managed.sessionIds) {
    if (getSession(sessionId)?.status !== "running") count++;
  }
  return count;
}

/**
 * Get all autoScaler running session counts for a user (for UI display).
 */
export function getAutoScalerSessionCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [id] of autoScalers) {
    counts.set(id, getAutoScalerRunningSessionCount(id));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Pool target calculation (pure function — the core of the reuse-based model)
// ---------------------------------------------------------------------------

/** Sentinel targetPool value meaning "retain the existing pool as-is" (N == 0 case). */
export const RETAIN_POOL = -1;

export interface PoolTargets {
  targetRunning: number;
  /** RETAIN_POOL when N == 0 — the pool must not be grown OR shrunk toward this. */
  targetPool: number;
}

/**
 * Compute the desired running count and desired total pool size (ready +
 * running) from the claimable count (C), non-done count (N), and the
 * concurrency cap. See this module's doc comment for the full model.
 */
export function computePoolTargets(claimableCount: number, nonDoneCount: number, cap: number): PoolTargets {
  if (claimableCount > 0) {
    const targetRunning = Math.min(cap, claimableCount + 1);
    return { targetRunning, targetPool: targetRunning };
  }
  if (nonDoneCount > 0) {
    const targetPool = Math.min(cap, Math.ceil(nonDoneCount / 2));
    const targetRunning = Math.min(cap, Math.ceil(targetPool / 2));
    return { targetRunning, targetPool };
  }
  return { targetRunning: 0, targetPool: RETAIN_POOL };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Core reconciliation: determines the target running count and target pool
 * size (see computePoolTargets), then:
 *   - starts ready (stopped) pooled sessions and/or creates new ones to reach
 *     targetRunning (reuse before create — see startOrCreatePooledSession),
 *   - winds down (stopSession, keeps as ready) surplus running sessions down
 *     to targetRunning,
 *   - grows the pool (creates ready-but-not-started sessions) up to targetPool,
 *   - trims the pool down to a decreased maxConcurrency cap (never below the
 *     current running count — an actively-claiming session is never killed
 *     just to satisfy a cap decrease),
 *   - updates the HWM,
 *   - runs the idle-age reaper opportunistically.
 *
 * @param stages - Pre-fetched agent stage states. When provided, the DB call to
 *   getAgentStageStates is skipped (used by reconcileLoop to avoid a redundant fetch).
 */
async function reconcile(managed: ManagedAutoScaler, stages?: { claimState: string; workingState: string }): Promise<void> {
  if (managed.abortController.signal.aborted) return;
  if (managed.reconciling) {
    // Another reconcile is already in progress — mark that a follow-up is needed
    // so the in-progress pass re-runs after finishing rather than silently dropping
    // this request. This prevents under-provisioning when a session dies during
    // an ongoing reconcile.
    managed.pendingReconcile = true;
    return;
  }
  managed.reconciling = true;

  try {
    const { autoScaler } = managed;

    // Untrack sessions that are truly gone (deleted) — NOT sessions that are
    // merely stopped/ready. A ready session is a pool member, not a dead one,
    // and must stay tracked so it can be reused on the next scale-up.
    for (const sessionId of [...managed.sessionIds]) {
      if (!getSession(sessionId)) {
        managed.sessionIds.delete(sessionId);
      }
    }

    const cap = autoScaler.maxConcurrency > 0 ? autoScaler.maxConcurrency : Infinity;

    // Cap decrease: trim the pool down before computing new targets, so a
    // lowered maxConcurrency takes effect even while N == 0 (pool retained).
    await trimPoolForCapDecrease(managed, cap);

    // Get agent stage states — reuse the provided snapshot if available (avoids
    // a redundant DB/config hit when called from reconcileLoop).
    const resolvedStages = stages ?? await getAgentStageStates(autoScaler.agentName);
    const claimableCount = await getAvailableTaskCount(
      autoScaler.tabIds,
      resolvedStages.claimState,
      resolvedStages.workingState
    );
    const nonDoneCount = await getNonDoneTaskCount(autoScaler.tabIds);

    const { targetRunning, targetPool } = computePoolTargets(claimableCount, nonDoneCount, cap);

    // HWM: monotonic non-decreasing (clamped down only by trimPoolForCapDecrease
    // above, which also lowers hwm directly when cap shrinks).
    if (targetPool !== RETAIN_POOL && targetPool > managed.hwm) {
      managed.hwm = targetPool;
    }

    const poolSize = managed.sessionIds.size;
    const runningCount = countRunning(managed);

    log.info("autoscaler-reconcile", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      claimableCount,
      nonDoneCount,
      cap: cap === Infinity ? 0 : cap,
      targetRunning,
      targetPool,
      poolSize,
      runningCount,
      hwm: managed.hwm,
      msg: `Reconcile: running ${runningCount}->${targetRunning}, pool ${poolSize}->${targetPool === RETAIN_POOL ? "retained" : targetPool}`,
    });

    // ─── Grow the pool (create ready sessions) up to targetPool ───────────
    if (targetPool !== RETAIN_POOL && targetPool > poolSize) {
      const toCreate = targetPool - poolSize;
      for (let i = 0; i < toCreate; i++) {
        if (managed.abortController.signal.aborted) break;
        try {
          const session = await createPooledSession(managed);
          if (session) managed.sessionIds.add(session.id);
        } catch (err) {
          log.warn("autoscaler-spawn-error", {
            component: "autoscaler-manager",
            autoScalerId: autoScaler.id,
            msg: `Failed to create pooled session: ${err instanceof Error ? err.message : err}`,
          });
          break;
        }
      }
    }

    // ─── Scale running count to targetRunning ──────────────────────────────
    const currentRunning = countRunning(managed);
    const toStart = targetRunning - currentRunning;

    if (toStart > 0) {
      // Clamp to available pool size — reuse ready sessions first, then create
      // new ones if the pool doesn't have enough ready members yet.
      for (let i = 0; i < toStart; i++) {
        if (managed.abortController.signal.aborted) break;
        try {
          const session = await startOrCreatePooledSession(managed);
          if (session) managed.sessionIds.add(session.id);
        } catch (err) {
          log.warn("autoscaler-spawn-error", {
            component: "autoscaler-manager",
            autoScalerId: autoScaler.id,
            msg: `Failed to start/create pooled session: ${err instanceof Error ? err.message : err}`,
          });
          break;
        }
      }
    } else if (toStart < 0) {
      // Surplus running sessions must wind down — stop (tear down container)
      // but KEEP the record as a ready pool member for reuse.
      const runningIds = [...managed.sessionIds].filter((id) => getSession(id)?.status === "running");
      const toStop = Math.min(-toStart, runningIds.length);
      for (let i = 0; i < toStop; i++) {
        const sessionId = runningIds[i];
        try {
          await stopSession(sessionId);
        } catch {
          // best-effort — session stays tracked either way
        }
      }
    }

    // Opportunistic idle-age reaper sweep (also runs on an hourly timer).
    await reapIdlePoolSessions(managed);
  } finally {
    managed.reconciling = false;
    // If a reconcile was dropped while we were busy, run it now so that session
    // deaths and task arrivals during the previous pass are not missed.
    if (managed.pendingReconcile && !managed.abortController.signal.aborted) {
      managed.pendingReconcile = false;
      reconcile(managed).catch(() => {});
    }
  }
}

/** Count how many of this autoscaler's tracked sessions are currently "running". */
function countRunning(managed: ManagedAutoScaler): number {
  let count = 0;
  for (const sessionId of managed.sessionIds) {
    if (getSession(sessionId)?.status === "running") count++;
  }
  return count;
}

/**
 * Trim the pool down when maxConcurrency has decreased below the current
 * pool size. Trims READY (not-running) sessions first, oldest lastUsedAt
 * first. Never kills an actively-claiming (running) session to satisfy a
 * cap decrease — if trimming ready sessions alone isn't enough to get under
 * the new cap, the excess running sessions are left alone; the cap is
 * respected as running sessions naturally finish and go idle on a later
 * reconcile pass. Clamps HWM down to the new cap.
 */
async function trimPoolForCapDecrease(managed: ManagedAutoScaler, cap: number): Promise<void> {
  if (cap === Infinity) return;
  if (cap < managed.hwm) {
    managed.hwm = cap;
  }

  const poolSize = managed.sessionIds.size;
  if (poolSize <= cap) return;

  const excess = poolSize - cap;

  // Fetch lastUsedAt for ordering — best-effort; sessions without a recorded
  // timestamp sort last (treated as most-recently-used, i.e. trimmed last).
  let lastUsedById = new Map<number, string>();
  try {
    const { autoScaler } = managed;
    const withLastUsed = await getPooledSessionsWithLastUsed(autoScaler.id);
    lastUsedById = new Map(withLastUsed.map((r) => [r.sessionId, r.lastUsedAt]));
  } catch {
    // best-effort — fall back to no ordering info
  }

  const readyIds = [...managed.sessionIds]
    .filter((id) => getSession(id)?.status !== "running")
    .sort((a, b) => {
      const aTime = lastUsedById.get(a) ? Date.parse(lastUsedById.get(a)!) : Infinity;
      const bTime = lastUsedById.get(b) ? Date.parse(lastUsedById.get(b)!) : Infinity;
      return aTime - bTime; // oldest first
    });

  const toDelete = readyIds.slice(0, excess);
  for (const sessionId of toDelete) {
    deleteSession(sessionId);
    managed.sessionIds.delete(sessionId);
    log.info("autoscaler-pool-trim", {
      component: "autoscaler-manager",
      autoScalerId: managed.autoScaler.id,
      sessionId,
      msg: `Trimmed ready session ${sessionId} from pool — maxConcurrency decreased`,
    });
  }
}

/**
 * Idle-age reaper: delete any pooled (ready, non-running) session whose
 * OWNS_SESSION edge lastUsedAt is older than POOL_MAX_IDLE_MS. Never reaps a
 * currently-running session.
 */
async function reapIdlePoolSessions(managed: ManagedAutoScaler): Promise<void> {
  if (managed.sessionIds.size === 0) return;

  let withLastUsed: Array<{ sessionId: number; lastUsedAt: string }>;
  try {
    withLastUsed = await getPooledSessionsWithLastUsed(managed.autoScaler.id);
  } catch {
    return; // best-effort — skip this sweep on DB error
  }

  const now = Date.now();
  for (const { sessionId, lastUsedAt } of withLastUsed) {
    if (!managed.sessionIds.has(sessionId)) continue;
    if (getSession(sessionId)?.status === "running") continue; // never reap a running session

    const age = now - Date.parse(lastUsedAt);
    if (Number.isFinite(age) && age > POOL_MAX_IDLE_MS) {
      deleteSession(sessionId);
      managed.sessionIds.delete(sessionId);
      log.info("autoscaler-pool-reaped", {
        component: "autoscaler-manager",
        autoScalerId: managed.autoScaler.id,
        sessionId,
        ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
        msg: `Reaped idle pooled session ${sessionId} (idle > ${POOL_MAX_IDLE_DAYS} day(s))`,
      });
    }
  }
}

/**
 * Create a new ready (not-started) pooled session: createSession(... loop:
 * true) WITHOUT startSession — no container, status "stopped", linked via
 * OWNS_SESSION. Used to grow the pool ahead of demand.
 */
async function createPooledSession(managed: ManagedAutoScaler): Promise<Session | null> {
  const { autoScaler } = managed;

  const session = await createSession({
    name: `${autoScaler.name} #${managed.sessionIds.size + 1}`,
    agent: autoScaler.agentName,
    loop: true,
    tabIds: autoScaler.tabIds,
    model: autoScaler.model,
    userId: autoScaler.userId,
    interactive: false,
    timeoutSeconds: 0,
  });

  // Durably link the session as owned/pooled by this autoScaler so the pool
  // survives a server restart (see db/autoscalers.ts's OWNS_SESSION edge).
  // Also mark it in-memory immediately so it's hidden from getAllSessions()
  // right away, without waiting for a server restart to pick up the DB fact.
  markSessionPooled(session.id);
  try {
    await linkPooledSession(autoScaler.id, session.id);
  } catch (err) {
    log.warn("autoscaler-pool-link-error", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      sessionId: session.id,
      msg: `Failed to persist pooled session link: ${err instanceof Error ? err.message : err}`,
    });
  }

  return session;
}

/**
 * Activate a session for scale-up: prefer reusing an existing ready (stopped,
 * pooled, not currently running) session over creating a new one. Falls back
 * to creating a fresh pooled session (and starting it) only when the pool has
 * no ready member available.
 */
async function startOrCreatePooledSession(managed: ManagedAutoScaler): Promise<Session | null> {
  const { autoScaler } = managed;

  // Find a ready (non-running) session already in the pool to reuse.
  const readyId = [...managed.sessionIds].find((id) => {
    const s = getSession(id);
    return s && s.status !== "running";
  });

  if (readyId !== undefined) {
    await startSession(readyId);
    try {
      await touchPooledSession(autoScaler.id, readyId);
    } catch (err) {
      log.warn("autoscaler-pool-touch-error", {
        component: "autoscaler-manager",
        autoScalerId: autoScaler.id,
        sessionId: readyId,
        msg: `Failed to update pooled session lastUsedAt: ${err instanceof Error ? err.message : err}`,
      });
    }
    armSessionWatchers(managed, readyId);
    return getSession(readyId) ?? null;
  }

  // No ready session available — create a new one and start it immediately.
  const session = await createPooledSession(managed);
  if (!session) return null;
  await startSession(session.id);
  try {
    await touchPooledSession(autoScaler.id, session.id);
  } catch {
    // best-effort — linkPooledSession's ON CREATE already set lastUsedAt
  }
  armSessionWatchers(managed, session.id);
  return session;
}

/**
 * Arm the completion + idle watchers for a session that just started
 * running. Shared by startOrCreatePooledSession so both the "reuse" and
 * "create fresh" paths get the same watchers.
 */
function armSessionWatchers(managed: ManagedAutoScaler, sessionId: number): void {
  const { autoScaler } = managed;

  // Watch for this session to finish (non-blocking).
  watchSessionCompletion(managed, sessionId);

  // Arm idle-death (idle-to-ready) timer for this session if idleTimeoutSeconds > 0.
  // idleTimeoutSeconds = 0 means "no idle timeout" — sessions run until the
  // autoscaler is stopped. This is intentional but can catch operators by
  // surprise, so we emit a warning to make it visible in the logs.
  if (autoScaler.idleTimeoutSeconds > 0) {
    watchSessionIdle(managed, sessionId);
  } else {
    log.warn("autoscaler-no-idle-timeout", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      sessionId,
      msg: "idleTimeoutSeconds=0: session will run indefinitely until the autoscaler is stopped. Set idleTimeoutSeconds > 0 to enable automatic idle-death.",
    });
  }
}

/**
 * Watch a autoScaler-owned session for completion (i.e. it stopped running
 * for a reason OTHER than the autoscaler's own idle-to-ready wind-down, e.g.
 * an unexpected crash). Triggers reconciliation, which will notice the
 * running count fell below target and start/create a replacement.
 *
 * Note: this watcher fires for ANY running->non-running transition, including
 * the deliberate idle-to-ready wind-down triggered by watchSessionIdle — that
 * is fine, since reconcile() is idempotent (targetRunning may legitimately be
 * lower now, in which case the extra reconcile pass is a no-op).
 */
function watchSessionCompletion(managed: ManagedAutoScaler, sessionId: number): void {
  const pollInterval = setInterval(() => {
    if (managed.abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    const session = getSession(sessionId);

    if (!session || session.status !== "running") {
      clearInterval(pollInterval);

      // Only untrack if the session is truly gone — a stopped/ready session
      // remains a pool member.
      if (!session) {
        managed.sessionIds.delete(sessionId);
      }

      // Trigger re-reconciliation if the autoScaler is still active.
      if (!managed.abortController.signal.aborted) {
        reconcile(managed).catch(() => {});
      }
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Arm an idle-to-ready timer for a running session.
 *
 * Polls the session's currentTaskId every second. If the session has not
 * claimed a new task within idleTimeoutSeconds, reconcile() is invoked
 * rather than unconditionally stopping the session — this makes idle-death
 * respect the current running target instead of the old single-floor
 * exemption: if targetRunning still needs this session (e.g. it's the sole
 * eager standby and C > 0), reconcile() is a no-op for it; only genuine
 * surplus gets wound down (stopSession — tears down the container, keeps
 * the record as a ready pool member for reuse).
 *
 * Resets the timer on each new claim.
 */
function watchSessionIdle(managed: ManagedAutoScaler, sessionId: number): void {
  const { autoScaler } = managed;
  const POLL_MS = 1000; // check every second

  let lastSeenTaskId: number | null | undefined = undefined; // undefined = initial / not yet seen
  let idleMs = 0;
  // Guard against concurrent async ticks: Node.js setInterval does not wait for an async
  // callback to finish before firing the next tick. If reconcile() (an async DB-driven
  // operation) takes longer than POLL_MS to return (e.g. a Neo4j latency spike), multiple
  // ticks could run simultaneously. This flag ensures only one tick is active at a time.
  let checking = false;

  const pollInterval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (managed.abortController.signal.aborted) {
        clearInterval(pollInterval);
        managed.idleIntervals.delete(pollInterval);
        return;
      }

      const session = getSession(sessionId);

      if (!session || session.status !== "running") {
        // Session is no longer running (wound down by a reconcile pass, or
        // gone entirely) — nothing left for this watcher to do.
        clearInterval(pollInterval);
        managed.idleIntervals.delete(pollInterval);
        return;
      }

      const currentTaskId = session.currentTaskId ?? null;

      if (lastSeenTaskId === undefined) {
        // First poll: initialise tracking, don't start the idle clock yet.
        lastSeenTaskId = currentTaskId;
        return;
      }

      if (currentTaskId !== lastSeenTaskId) {
        // A new task was claimed — reset the idle counter.
        lastSeenTaskId = currentTaskId;
        idleMs = 0;
        return;
      }

      // No new claim since the last poll.
      idleMs += POLL_MS;

      if (idleMs < autoScaler.idleTimeoutSeconds * 1000) {
        return; // not yet timed out
      }

      // Timed out — trigger a reconcile pass so the wind-down decision is
      // made against the current targetRunning (not this watcher's own
      // hardcoded assumption). Reset the idle clock: if reconcile() decides
      // this session is still needed, the timer starts fresh instead of
      // firing again on every subsequent poll.
      idleMs = 0;
      log.info("autoscaler-idle-check", {
        component: "autoscaler-manager",
        autoScalerId: autoScaler.id,
        sessionId,
        msg: `Session idle for ${autoScaler.idleTimeoutSeconds}s — reconciling to decide wind-down`,
      });

      if (managed.abortController.signal.aborted) {
        clearInterval(pollInterval);
        managed.idleIntervals.delete(pollInterval);
        return;
      }

      try {
        await reconcile(managed);
      } catch {
        // best-effort — reconcile() has its own error handling/backoff via reconcileLoop
      }

      // If reconcile() wound this session down, stop polling it — a fresh
      // watcher is armed the next time it's started (startOrCreatePooledSession).
      const after = getSession(sessionId);
      if (!after || after.status !== "running") {
        clearInterval(pollInterval);
        managed.idleIntervals.delete(pollInterval);
      }
    } finally {
      checking = false;
    }
  }, POLL_MS);
  // Register the interval handle so stopAutoScaler can clear it immediately on teardown.
  managed.idleIntervals.add(pollInterval);
}

/**
 * Main reconciliation loop: waits for task-available events and re-reconciles.
 *
 * The loop body is wrapped in a try/catch so a single transient failure
 * (e.g. a Neo4j network hiccup) retries after a brief backoff rather than
 * killing the loop permanently. Without this, any DB error would propagate
 * out of the while loop, the call-site `.catch()` would log a warning, and
 * the autoscaler would stop scaling forever until manually restarted.
 */
async function reconcileLoop(managed: ManagedAutoScaler): Promise<void> {
  const { autoScaler } = managed;
  const signal = managed.abortController.signal;

  // Run the initial reconcile pass, then keep reconciling whenever a new task
  // becomes available. Each iteration (including the first) is wrapped in a
  // try/catch so transient errors retry with a brief backoff rather than
  // killing the loop permanently.
  //
  // Structure: the first iteration runs an initial reconcile without waiting;
  // subsequent iterations wait for a task-available event first.
  let firstIteration = true;

  while (!signal.aborted) {
    try {
      // Fetch agent stage states fresh each iteration so both waitForTaskAvailable
      // and reconcile always use the same, up-to-date snapshot.
      const stages = await getAgentStageStates(autoScaler.agentName);

      if (!firstIteration) {
        // Wait for a new task to become available before reconciling again.
        await waitForTaskAvailable(autoScaler.tabIds, stages.claimState, signal, stages.workingState);
        if (signal.aborted) break;
      }
      firstIteration = false;

      await reconcile(managed, stages);
    } catch (err) {
      if (signal.aborted) break;
      log.warn("autoscaler-reconcile-error", {
        component: "autoscaler-manager",
        autoScalerId: autoScaler.id,
        msg: `Reconcile loop iteration failed, will retry: ${err instanceof Error ? err.message : err}`,
      });
      firstIteration = false;
      // Brief backoff before retrying to avoid a tight error loop.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
