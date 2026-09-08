/**
 * AutoScaler Manager — auto-scaling session pools.
 *
 * A "AutoScaler" watches the claimable task queue for a specific agent/tab
 * combination and spins up loop sessions to match, up to a configurable
 * concurrency cap. Each session claims tasks until idle for
 * `idleTimeoutSeconds`, then stops itself, freeing its concurrency slot.
 * A new task arriving at any time triggers a reconciliation pass that may
 * spawn fresh sessions.
 *
 * THREE COORDINATED BEHAVIORS
 * ───────────────────────────
 * 1. Scale on task arrival: when tasks transition into a claimable state, the
 *    reconcile loop wakes (via waitForTaskAvailable) and spawns sessions.
 *    Routes already call notifyTaskAvailable() on state changes — no extra
 *    wiring needed here.
 *
 * 2. Keep-warm floor (keepWarmWhileTasksExist): when enabled, maintains
 *    exactly one "floor session" running as long as any non-done task exists
 *    in the autoscaler's tabs, even if nothing is currently claimable (e.g.
 *    all tasks are blocked by dependencies). The floor session is exempt from
 *    idle-death (behavior 3). When all tasks reach "done", the floor drops to
 *    0. When disabled (default), desired stays at 0 until something is
 *    actually claimable.
 *
 *    Desired formula:
 *      floor = (keepWarmWhileTasksExist && nonDoneCount > 0) ? 1 : 0
 *      desired = max(floor, min(maxConcurrency || Infinity, claimableCount))
 *
 * 3. Idle-then-die: sessions are spawned as loop: true. The autoscaler arms
 *    a per-session idle timer: if a session goes idleTimeoutSeconds without
 *    claiming a new task (detected by polling currentTaskId for changes), it
 *    is stopped. The single floor session is exempt — it is kept running as
 *    long as a non-done task exists regardless of idle time.
 *
 * Run-state (which sessions belong to a running AutoScaler) is in-memory only,
 * matching the existing session-manager pattern. Only the AutoScaler's
 * configuration record persists across restarts.
 */

import { broadcastToUser } from "./websocket-handler.js";
import { createAutoScaler as dbCreateAutoScaler, getAutoScalerById, getAllAutoScalers as dbGetAllAutoScalers, updateAutoScalerStatus, deleteAutoScaler as dbDeleteAutoScaler } from "./db/autoscalers.js";
import { getAvailableTaskCount, getNonDoneTaskCount, waitForTaskAvailable } from "./agent/task-claimer.js";
import { createSession, startSession, stopSession, getAllSessions } from "./session-manager.js";
import { getAgentStageStates } from "./session-manager.js";
import { log } from "./logger.js";
import type { AutoScaler, CreateAutoScalerInput, Session } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory autoScaler state
// ---------------------------------------------------------------------------

interface ManagedAutoScaler {
  autoScaler: AutoScaler;
  /** Session IDs currently owned by this autoScaler. */
  sessionIds: Set<number>;
  /**
   * The "floor" session ID — exempt from idle-death when keepWarmWhileTasksExist
   * is true and non-done tasks exist. Always the first session spawned in a
   * reconciliation cycle that includes a floor requirement. Null when no floor
   * session exists.
   */
  floorSessionId: number | null;
  /** AbortController for the reconciliation loop. */
  abortController: AbortController;
  /** Whether a reconciliation is currently in progress (prevents re-entrant runs). */
  reconciling: boolean;
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
    floorSessionId: null,
    abortController: new AbortController(),
    reconciling: false,
  };
  autoScalers.set(autoScalerId, managed);

  broadcastToUser(updated.userId, { type: "autoscaler-updated", autoScaler: updated });

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

    // Stop all owned sessions.
    for (const sessionId of managed.sessionIds) {
      try {
        await stopSession(sessionId);
      } catch {
        // best-effort
      }
    }
    managed.sessionIds.clear();
    managed.floorSessionId = null;
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
 */
export function getAutoScalerRunningSessionCount(autoScalerId: number): number {
  return autoScalers.get(autoScalerId)?.sessionIds.size ?? 0;
}

/**
 * Get all autoScaler running session counts for a user (for UI display).
 */
export function getAutoScalerSessionCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [id, managed] of autoScalers) {
    counts.set(id, managed.sessionIds.size);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Core reconciliation: determines how many sessions should be running and
 * spawns to reach the target. Sessions die on their own idle timer (behavior 3)
 * or are stopped by stopAutoScaler.
 *
 * Desired formula:
 *   floor = (keepWarmWhileTasksExist && nonDoneCount > 0) ? 1 : 0
 *   desired = max(floor, min(maxConcurrency || Infinity, claimableCount))
 */
async function reconcile(managed: ManagedAutoScaler): Promise<void> {
  if (managed.abortController.signal.aborted) return;
  if (managed.reconciling) return;
  managed.reconciling = true;

  try {
    const { autoScaler } = managed;

    // Prune sessions that are no longer running.
    const allSessions = getAllSessions(autoScaler.userId);
    for (const sessionId of [...managed.sessionIds]) {
      const session = allSessions.find((s) => s.id === sessionId);
      if (!session || session.status !== "running") {
        managed.sessionIds.delete(sessionId);
        if (managed.floorSessionId === sessionId) {
          managed.floorSessionId = null;
        }
      }
    }

    // Get available task count using agent's stage states.
    const stages = await getAgentStageStates(autoScaler.agentName);
    const claimableCount = await getAvailableTaskCount(
      autoScaler.tabIds,
      stages.claimState,
      stages.workingState
    );

    // Compute floor: 1 if keepWarmWhileTasksExist and any non-done tasks exist.
    let floor = 0;
    if (autoScaler.keepWarmWhileTasksExist) {
      const nonDoneCount = await getNonDoneTaskCount(autoScaler.tabIds);
      floor = nonDoneCount > 0 ? 1 : 0;
    }

    const currentRunning = managed.sessionIds.size;
    const cap = autoScaler.maxConcurrency > 0 ? autoScaler.maxConcurrency : Infinity;
    const desired = Math.max(floor, Math.min(cap, claimableCount));

    const toSpawn = desired - currentRunning;
    if (toSpawn <= 0) return;

    log.info("autoscaler-reconcile", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      claimableCount,
      floor,
      currentRunning,
      desired,
      toSpawn,
      msg: `Spawning ${toSpawn} session(s)`,
    });

    for (let i = 0; i < toSpawn; i++) {
      if (managed.abortController.signal.aborted) break;
      try {
        // Is this the floor/warm session? Mark it if we need a floor and
        // don't already have one.
        const isFloorSession = floor > 0 && managed.floorSessionId === null;
        const session = await spawnAutoScalerSession(managed);
        if (session) {
          managed.sessionIds.add(session.id);
          if (isFloorSession) {
            managed.floorSessionId = session.id;
          }
        }
      } catch (err) {
        log.warn("autoscaler-spawn-error", {
          component: "autoscaler-manager",
          autoScalerId: autoScaler.id,
          msg: `Failed to spawn session: ${err instanceof Error ? err.message : err}`,
        });
        break;
      }
    }
  } finally {
    managed.reconciling = false;
  }
}

/**
 * Spawn a loop session for the autoScaler.
 */
async function spawnAutoScalerSession(managed: ManagedAutoScaler): Promise<Session | null> {
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

  // Start the session.
  await startSession(session.id);

  // Watch for this session to finish (non-blocking).
  watchSessionCompletion(managed, session.id);

  // Arm idle-death timer for this session if idleTimeoutSeconds > 0.
  if (autoScaler.idleTimeoutSeconds > 0) {
    watchSessionIdle(managed, session.id);
  }

  return session;
}

/**
 * Watch a autoScaler-owned session for completion. When it stops, trigger
 * reconciliation to potentially spawn a replacement.
 */
function watchSessionCompletion(managed: ManagedAutoScaler, sessionId: number): void {
  const pollInterval = setInterval(() => {
    if (managed.abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    const allSessions = getAllSessions(managed.autoScaler.userId);
    const session = allSessions.find((s) => s.id === sessionId);

    if (!session || session.status !== "running") {
      clearInterval(pollInterval);
      managed.sessionIds.delete(sessionId);
      if (managed.floorSessionId === sessionId) {
        managed.floorSessionId = null;
      }

      // Trigger re-reconciliation if the autoScaler is still active.
      if (!managed.abortController.signal.aborted) {
        reconcile(managed).catch(() => {});
      }
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Arm an idle-death timer for a spawned session.
 *
 * Polls the session's currentTaskId every second. If the session has not
 * claimed a new task within idleTimeoutSeconds, it is stopped — UNLESS it
 * is the floor session (managed.floorSessionId) and a non-done task still
 * exists (checked by getNonDoneTaskCount).
 *
 * Resets the timer on each new claim.
 */
function watchSessionIdle(managed: ManagedAutoScaler, sessionId: number): void {
  const { autoScaler } = managed;
  const POLL_MS = 1000; // check every second

  let lastSeenTaskId: number | null | undefined = undefined; // undefined = initial / not yet seen
  let idleMs = 0;

  const pollInterval = setInterval(async () => {
    if (managed.abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    const allSessions = getAllSessions(autoScaler.userId);
    const session = allSessions.find((s) => s.id === sessionId);

    if (!session || session.status !== "running") {
      // Session is gone — nothing to do, watchSessionCompletion handles cleanup.
      clearInterval(pollInterval);
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

    // Timed out. Check if this is the floor session and should be exempted.
    const isFloorSession = managed.floorSessionId === sessionId;
    if (isFloorSession && autoScaler.keepWarmWhileTasksExist) {
      // Check whether any non-done task still exists — if so, keep it alive.
      try {
        const nonDoneCount = await getNonDoneTaskCount(autoScaler.tabIds);
        if (nonDoneCount > 0) {
          // Floor session is exempt — reset the idle clock and continue.
          idleMs = 0;
          return;
        }
        // No non-done tasks left — the floor is no longer needed; stop this session.
      } catch {
        // DB error — be conservative and keep the session alive.
        idleMs = 0;
        return;
      }
    }

    // Stop this idle session.
    clearInterval(pollInterval);
    log.info("autoscaler-idle-stop", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      sessionId,
      isFloorSession,
      msg: `Session idle for ${autoScaler.idleTimeoutSeconds}s — stopping`,
    });

    try {
      await stopSession(sessionId);
    } catch {
      // best-effort
    }
    // watchSessionCompletion will handle the cleanup and re-reconcile.
  }, POLL_MS);
}

/**
 * Main reconciliation loop: waits for task-available events and re-reconciles.
 */
async function reconcileLoop(managed: ManagedAutoScaler): Promise<void> {
  const { autoScaler } = managed;
  const signal = managed.abortController.signal;

  // Initial reconciliation.
  await reconcile(managed);

  const stages = await getAgentStageStates(autoScaler.agentName);

  // Keep reconciling whenever a new task becomes available.
  while (!signal.aborted) {
    await waitForTaskAvailable(autoScaler.tabIds, stages.claimState, signal, stages.workingState);
    if (signal.aborted) break;
    await reconcile(managed);
  }
}
