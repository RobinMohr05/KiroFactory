/**
 * AutoScaler Manager — auto-scaling session pools.
 *
 * A "AutoScaler" watches the claimable task queue for a specific agent/tab
 * combination and spins up single-claim sessions to match, up to a
 * configurable concurrency cap. Each session claims one task, resolves it,
 * then idles for `idleTimeoutSeconds`. If no new task arrives in that
 * window, the session stops itself, freeing its concurrency slot. A new
 * task arriving at any time triggers a reconciliation pass that may spawn
 * fresh sessions.
 *
 * Run-state (which sessions belong to a running AutoScaler) is in-memory only,
 * matching the existing session-manager pattern. Only the AutoScaler's
 * configuration record persists across restarts.
 */

import { broadcastToUser } from "./websocket-handler.js";
import { createAutoScaler as dbCreateAutoScaler, getAutoScalerById, getAllAutoScalers as dbGetAllAutoScalers, updateAutoScalerStatus, deleteAutoScaler as dbDeleteAutoScaler } from "./db/autoscalers.js";
import { getAvailableTaskCount, waitForTaskAvailable, notifyTaskAvailable } from "./agent/task-claimer.js";
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
 * spawns or lets natural attrition bring the count to the target.
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
      }
    }

    // Get available task count using agent's stage states.
    const stages = await getAgentStageStates(autoScaler.agentName);
    const availableCount = await getAvailableTaskCount(
      autoScaler.tabIds,
      stages.claimState,
      stages.workingState
    );

    const currentRunning = managed.sessionIds.size;
    const desired =
      autoScaler.maxConcurrency > 0
        ? Math.min(autoScaler.maxConcurrency, availableCount)
        : availableCount;

    const toSpawn = desired - currentRunning;
    if (toSpawn <= 0) return;

    log.info("autoscaler-reconcile", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      availableCount,
      currentRunning,
      desired,
      toSpawn,
      msg: `Spawning ${toSpawn} session(s)`,
    });

    for (let i = 0; i < toSpawn; i++) {
      if (managed.abortController.signal.aborted) break;
      try {
        const session = await spawnAutoScalerSession(managed);
        if (session) {
          managed.sessionIds.add(session.id);
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
 * Spawn a single-claim session for the autoScaler.
 */
async function spawnAutoScalerSession(managed: ManagedAutoScaler): Promise<Session | null> {
  const { autoScaler } = managed;

  const session = await createSession({
    name: `${autoScaler.name} #${managed.sessionIds.size + 1}`,
    agent: autoScaler.agentName,
    loop: true,
    runs: 1, // single claim: one task, then idle/stop
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

      // Trigger re-reconciliation if the autoScaler is still active.
      if (!managed.abortController.signal.aborted) {
        reconcile(managed).catch(() => {});
      }
    }
  }, 5000); // Check every 5 seconds
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
