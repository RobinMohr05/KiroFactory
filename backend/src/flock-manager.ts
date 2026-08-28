/**
 * Flock Manager — auto-scaling session pools.
 *
 * A "Flock" watches the claimable task queue for a specific agent/tab
 * combination and spins up single-claim sessions to match, up to a
 * configurable concurrency cap. Each session claims one task, resolves it,
 * then idles for `idleTimeoutSeconds`. If no new task arrives in that
 * window, the session stops itself, freeing its concurrency slot. A new
 * task arriving at any time triggers a reconciliation pass that may spawn
 * fresh sessions.
 *
 * Run-state (which sessions belong to a running Flock) is in-memory only,
 * matching the existing session-manager pattern. Only the Flock's
 * configuration record persists across restarts.
 */

import { broadcastToUser } from "./websocket-handler.js";
import { createFlock as dbCreateFlock, getFlockById, getAllFlocks as dbGetAllFlocks, updateFlockStatus, deleteFlock as dbDeleteFlock } from "./db/flocks.js";
import { getAvailableTaskCount, waitForTaskAvailable, notifyTaskAvailable } from "./agent/task-claimer.js";
import { createSession, startSession, stopSession, getAllSessions } from "./session-manager.js";
import { getAgentStageStates } from "./session-manager.js";
import { log } from "./logger.js";
import type { Flock, CreateFlockInput, Session } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory flock state
// ---------------------------------------------------------------------------

interface ManagedFlock {
  flock: Flock;
  /** Session IDs currently owned by this flock. */
  sessionIds: Set<number>;
  /** AbortController for the reconciliation loop. */
  abortController: AbortController;
  /** Whether a reconciliation is currently in progress (prevents re-entrant runs). */
  reconciling: boolean;
}

const flocks = new Map<number, ManagedFlock>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new Flock (persisted, NOT auto-started).
 */
export async function createFlockRecord(input: CreateFlockInput): Promise<Flock> {
  const flock = await dbCreateFlock(input);
  broadcastToUser(flock.userId, { type: "flock-created", flock });
  return flock;
}

/**
 * Get all Flocks for a user.
 */
export async function getAllFlocks(userId: number): Promise<Flock[]> {
  return dbGetAllFlocks(userId);
}

/**
 * Start a Flock — begins reconciliation loop.
 */
export async function startFlock(flockId: number): Promise<Flock | null> {
  const flock = await getFlockById(flockId);
  if (!flock) return null;

  // Already running?
  if (flocks.has(flockId)) {
    return flock;
  }

  const updated = await updateFlockStatus(flockId, "running");
  if (!updated) return null;

  const managed: ManagedFlock = {
    flock: updated,
    sessionIds: new Set(),
    abortController: new AbortController(),
    reconciling: false,
  };
  flocks.set(flockId, managed);

  broadcastToUser(updated.userId, { type: "flock-updated", flock: updated });

  // Start the reconciliation loop (non-blocking).
  reconcileLoop(managed).catch((err) => {
    log.warn("flock-reconcile-error", {
      component: "flock-manager",
      flockId,
      msg: `Reconciliation loop crashed: ${err.message || err}`,
    });
  });

  return updated;
}

/**
 * Stop a Flock — stops all owned sessions and marks it stopped.
 */
export async function stopFlock(flockId: number): Promise<Flock | null> {
  const managed = flocks.get(flockId);

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
    flocks.delete(flockId);
  }

  const updated = await updateFlockStatus(flockId, "stopped");
  if (updated) {
    broadcastToUser(updated.userId, { type: "flock-updated", flock: updated });
  }
  return updated;
}

/**
 * Delete a Flock. Stops it first if running.
 */
export async function deleteFlockRecord(flockId: number): Promise<boolean> {
  // Stop first if running.
  const managed = flocks.get(flockId);
  if (managed) {
    await stopFlock(flockId);
  }

  const flock = await getFlockById(flockId);
  const deleted = await dbDeleteFlock(flockId);
  if (deleted && flock) {
    broadcastToUser(flock.userId, { type: "flock-deleted", flockId });
  }
  return deleted;
}

/**
 * Get the running session count for a flock (for UI display).
 */
export function getFlockRunningSessionCount(flockId: number): number {
  return flocks.get(flockId)?.sessionIds.size ?? 0;
}

/**
 * Get all flock running session counts for a user (for UI display).
 */
export function getFlockSessionCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [id, managed] of flocks) {
    counts.set(id, managed.sessionIds.size);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Core reconciliation: determines how many sessions should be running and
 * spawns or lets natural attrition bring the count to the target.
 */
async function reconcile(managed: ManagedFlock): Promise<void> {
  if (managed.abortController.signal.aborted) return;
  if (managed.reconciling) return;
  managed.reconciling = true;

  try {
    const { flock } = managed;

    // Prune sessions that are no longer running.
    const allSessions = getAllSessions(flock.userId);
    for (const sessionId of [...managed.sessionIds]) {
      const session = allSessions.find((s) => s.id === sessionId);
      if (!session || session.status !== "running") {
        managed.sessionIds.delete(sessionId);
      }
    }

    // Get available task count using agent's stage states.
    const stages = await getAgentStageStates(flock.agentName);
    const availableCount = await getAvailableTaskCount(
      flock.tabIds,
      stages.claimState,
      stages.workingState
    );

    const currentRunning = managed.sessionIds.size;
    const desired =
      flock.maxConcurrency > 0
        ? Math.min(flock.maxConcurrency, availableCount)
        : availableCount;

    const toSpawn = desired - currentRunning;
    if (toSpawn <= 0) return;

    log.info("flock-reconcile", {
      component: "flock-manager",
      flockId: flock.id,
      availableCount,
      currentRunning,
      desired,
      toSpawn,
      msg: `Spawning ${toSpawn} session(s)`,
    });

    for (let i = 0; i < toSpawn; i++) {
      if (managed.abortController.signal.aborted) break;
      try {
        const session = await spawnFlockSession(managed);
        if (session) {
          managed.sessionIds.add(session.id);
        }
      } catch (err) {
        log.warn("flock-spawn-error", {
          component: "flock-manager",
          flockId: flock.id,
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
 * Spawn a single-claim session for the flock.
 */
async function spawnFlockSession(managed: ManagedFlock): Promise<Session | null> {
  const { flock } = managed;

  const session = await createSession({
    name: `${flock.name} #${managed.sessionIds.size + 1}`,
    agent: flock.agentName,
    loop: true,
    runs: 1, // single claim: one task, then idle/stop
    tabIds: flock.tabIds,
    model: flock.model,
    userId: flock.userId,
    interactive: false,
    timeoutSeconds: 0,
  });

  // Start the session.
  await startSession(session.id);

  // Watch for this session to finish (non-blocking).
  watchSessionCompletion(managed, session.id);

  return session;
}

/**
 * Watch a flock-owned session for completion. When it stops, trigger
 * reconciliation to potentially spawn a replacement.
 */
function watchSessionCompletion(managed: ManagedFlock, sessionId: number): void {
  const pollInterval = setInterval(() => {
    if (managed.abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    const allSessions = getAllSessions(managed.flock.userId);
    const session = allSessions.find((s) => s.id === sessionId);

    if (!session || session.status !== "running") {
      clearInterval(pollInterval);
      managed.sessionIds.delete(sessionId);

      // Trigger re-reconciliation if the flock is still active.
      if (!managed.abortController.signal.aborted) {
        reconcile(managed).catch(() => {});
      }
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Main reconciliation loop: waits for task-available events and re-reconciles.
 */
async function reconcileLoop(managed: ManagedFlock): Promise<void> {
  const { flock } = managed;
  const signal = managed.abortController.signal;

  // Initial reconciliation.
  await reconcile(managed);

  const stages = await getAgentStageStates(flock.agentName);

  // Keep reconciling whenever a new task becomes available.
  while (!signal.aborted) {
    await waitForTaskAvailable(flock.tabIds, stages.claimState, signal, stages.workingState);
    if (signal.aborted) break;
    await reconcile(managed);
  }
}
