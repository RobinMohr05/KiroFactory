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
import { createAutoScaler as dbCreateAutoScaler, getAutoScalerById, getAllAutoScalers as dbGetAllAutoScalers, updateAutoScalerStatus, updateAutoScaler as dbUpdateAutoScaler, deleteAutoScaler as dbDeleteAutoScaler } from "./db/autoscalers.js";
import { getAvailableTaskCount, getNonDoneTaskCount, waitForTaskAvailable } from "./agent/task-claimer.js";
import { createSession, startSession, stopSession, getAllSessions } from "./session-manager.js";
import { getAgentStageStates } from "./session-manager.js";
import { log } from "./logger.js";
import { isAcaModeEnabled } from "./aca-worker-spawner.js";
import { NO_TASKS_PARK_DETAIL } from "./types.js";
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
  /**
   * Debounce timer for reconcile calls triggered by watchSessionCompletion. Multiple
   * near-simultaneous session deaths (e.g. an entire burst idle-timing out within the
   * same 5s poll window) each call reconcile — without a debounce each death triggers
   * its own full reconcile pass, compounding the thundering-herd. This timer collapses
   * those into a single deferred reconcile call.
   *
   * Null when no deferred reconcile is pending.
   */
  completionReconcileTimer: ReturnType<typeof setTimeout> | null;
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
    floorSessionId: null,
    abortController: new AbortController(),
    reconciling: false,
    pendingReconcile: false,
    idleIntervals: new Set(),
    completionReconcileTimer: null,
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

    // Explicitly clear all idle-watcher intervals so they stop immediately
    // rather than relying on lazy self-cleanup on the next tick. Without this,
    // intervals fire one more time (up to 1s later) after abort, which can
    // produce spurious stopSession calls and log entries during teardown.
    for (const handle of managed.idleIntervals) {
      clearInterval(handle);
    }
    managed.idleIntervals.clear();

    // Cancel any pending debounced reconcile so it doesn't fire after teardown.
    if (managed.completionReconcileTimer !== null) {
      clearTimeout(managed.completionReconcileTimer);
      managed.completionReconcileTimer = null;
    }

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

    // Get agent stage states — reuse the provided snapshot if available (avoids
    // a redundant DB/config hit when called from reconcileLoop).
    const resolvedStages = stages ?? await getAgentStageStates(autoScaler.agentName);
    const claimableCount = await getAvailableTaskCount(
      autoScaler.tabIds,
      resolvedStages.claimState,
      resolvedStages.workingState
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
      let spawnedSessionId: number | null = null;
      try {
        // Is this the floor/warm session? Mark it if we need a floor and
        // don't already have one.
        const isFloorSession = floor > 0 && managed.floorSessionId === null;
        const session = await spawnAutoScalerSession(managed);
        if (session) {
          spawnedSessionId = session.id;
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

      // Serialize spawns to prevent the thundering-herd (task #1682): before
      // spawning the NEXT session, wait for the one just spawned to reach an
      // OBSERVABLE state. Its loop body runs getAvailableTaskCount/claimTask on
      // start: on success currentTaskId becomes non-null ("claimed"); on an
      // empty queue it sets the idle NO_TASKS_PARK_DETAIL activity ("parked").
      // If neither is observed within SPAWN_CLAIM_WAIT_MS the session is still
      // cold-starting ("starting") — common and healthy in ACA mode.
      //
      // Only a genuine "parked" (or, in local mode, an anomalous "starting")
      // halts the burst: that means a sibling won the race for the last task or
      // the queue is already empty, so spawning more siblings would just add to
      // the burst of short-lived sessions the bug describes.
      //
      // We deliberately do NOT re-read getAvailableTaskCount between spawns:
      // that count is cached for COUNT_CACHE_TTL_MS (5s) keyed on
      // tabIds/claimState/workingState and is only invalidated by
      // notifyTaskAvailable() (task creation/reset), never by a successful
      // claim. A whole reconcile pass finishes well under 5s, so every re-read
      // returns the identical cached value and can never trim the burst — it
      // was a no-op. The spawned session's actual claim/park signal is the only
      // thing that reflects a sibling winning the race for a task.
      //
      // Skip the wait on the last planned spawn (no next iteration to gate).
      if (spawnedSessionId !== null && i < toSpawn - 1 && !managed.abortController.signal.aborted) {
        const outcome = await waitForSessionToClaimOrPark(managed, spawnedSessionId);
        // A genuine empty-queue park always halts the burst. A "starting"
        // (not-yet-connected) session only halts in local mode — in ACA mode a
        // slow-but-healthy cold-start routinely exceeds the wait window and must
        // NOT be misread as a park (that would cap concurrency at 1 and defeat
        // maxConcurrency — the PR-review defect). "claimed" continues the burst.
        const shouldHalt = outcome === "parked" || (outcome === "starting" && !isAcaModeEnabled());
        if (shouldHalt) {
          log.info("autoscaler-spawn-halt", {
            component: "autoscaler-manager",
            autoScalerId: autoScaler.id,
            sessionId: spawnedSessionId,
            outcome,
            msg:
              outcome === "parked"
                ? "Spawned session parked without claiming a task — halting this reconcile's spawn burst to avoid a thundering herd"
                : "Spawned session did not claim or park within the wait window (local mode) — halting this reconcile's spawn burst",
          });
          break;
        }
      }
    }
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

/**
 * How long (ms) reconcile() waits for a freshly-spawned session to reach an
 * OBSERVABLE state (claimed a task, or parked on an empty queue) before giving
 * up on the wait.
 *
 * A spawned session's loop body (session-manager.ts runLoopMode/runLoopModeAca)
 * runs getAvailableTaskCount then claimTask on start; on success it sets
 * currentTaskId, and on an empty queue it sets its currentActivity to the idle
 * NO_TASKS_PARK_DETAIL signal before suspending in waitForTaskAvailable. For a
 * local session either happens within a few hundred ms.
 *
 * The ACA path is much slower: the worker is launched async and un-awaited, and
 * before the loop body can run at all the container must cold-start (image
 * start, Node boot, WebSocket handshake back to the orchestrator, ACP session
 * init). That routinely takes well over this window. Critically, such a session
 * has NEITHER claimed NOR parked yet — it simply hasn't connected. Timing out
 * on it must NOT be read as "parked" (see waitForSessionToClaimOrPark's
 * three-valued result and reconcile()'s handling of "starting" in ACA mode),
 * otherwise a slow-but-healthy cold start would cap the burst at one session and
 * silently defeat maxConcurrency parallelism.
 */
const SPAWN_CLAIM_WAIT_MS = 10000;

/** Poll interval (ms) while waiting for a spawned session to claim a task. */
const SPAWN_CLAIM_POLL_MS = 250;

/**
 * Outcome of waiting on a freshly-spawned session:
 * - "claimed": it observably picked up a task (currentTaskId set). Safe to
 *   spawn the next sibling.
 * - "parked":  its loop body ran, found the queue empty, and parked (its
 *   currentActivity is the idle NO_TASKS_PARK_DETAIL signal). Spawning more
 *   siblings would just add to the thundering herd — halt the burst.
 * - "starting": the wait window elapsed without either signal — the session is
 *   still cold-starting (typical in ACA mode) and hasn't connected yet. This is
 *   NOT a park; treating it as one is the PR-review defect this distinction
 *   fixes.
 */
type SpawnWaitOutcome = "claimed" | "parked" | "starting";

/**
 * Wait for a just-spawned session to observably claim a task (currentTaskId
 * becomes non-null) or "park" (its loop body found an empty queue and set the
 * idle NO_TASKS_PARK_DETAIL activity). Returns:
 * - "claimed" if it claimed a task,
 * - "parked" if it genuinely parked on an empty queue,
 * - "starting" if the wait window elapsed with neither signal (still booting),
 *   or the session disappeared / was stopped / the autoscaler was aborted.
 *
 * Distinguishing "parked" from "starting" is what lets the serialized-spawn
 * gate prevent the thundering herd WITHOUT under-provisioning slow ACA
 * cold-starts: only a genuine park (loop body ran, saw nothing to do) halts the
 * burst; a session that merely hasn't connected yet does not.
 */
async function waitForSessionToClaimOrPark(
  managed: ManagedAutoScaler,
  sessionId: number
): Promise<SpawnWaitOutcome> {
  const { autoScaler } = managed;
  const deadline = Date.now() + SPAWN_CLAIM_WAIT_MS;

  while (Date.now() < deadline) {
    if (managed.abortController.signal.aborted) return "starting";

    const session = getAllSessions(autoScaler.userId).find((s) => s.id === sessionId);
    // Session gone or no longer running — treat as "starting" (not a park) so
    // the burst isn't halted on its account; watchSessionCompletion handles its
    // cleanup/re-reconcile.
    if (!session || session.status !== "running") return "starting";
    // Claimed a task — its loop set currentTaskId. Safe to spawn the next one.
    if (session.currentTaskId != null) return "claimed";
    // Ran its loop body, found nothing claimable, and parked. This is the
    // genuine "empty queue" signal that should halt the burst.
    if (
      session.currentActivity?.type === "idle" &&
      session.currentActivity.detail === NO_TASKS_PARK_DETAIL
    ) {
      return "parked";
    }

    await new Promise((r) => setTimeout(r, SPAWN_CLAIM_POLL_MS));
  }

  // Window elapsed without claiming or parking — the session is still starting
  // up (hasn't run its loop body yet). Not a park.
  return "starting";
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
  // idleTimeoutSeconds = 0 means "no idle timeout" — sessions run until the
  // autoscaler is stopped. This is intentional but can catch operators by
  // surprise, so we emit a warning to make it visible in the logs.
  if (autoScaler.idleTimeoutSeconds > 0) {
    watchSessionIdle(managed, session.id);
  } else {
    log.warn("autoscaler-no-idle-timeout", {
      component: "autoscaler-manager",
      autoScalerId: autoScaler.id,
      sessionId: session.id,
      msg: "idleTimeoutSeconds=0: session will run indefinitely until the autoscaler is stopped. Set idleTimeoutSeconds > 0 to enable automatic idle-death.",
    });
  }

  return session;
}

/**
 * Watch a autoScaler-owned session for completion. When it stops, trigger
 * reconciliation to potentially spawn a replacement.
 *
 * Uses a short debounce (COMPLETION_RECONCILE_DEBOUNCE_MS) so that multiple
 * near-simultaneous session deaths (e.g. an entire spawned burst idle-timing out
 * within the same 5-second poll window) coalesce into a single reconcile pass
 * rather than each triggering an independent full pass. Without the debounce,
 * N dying sessions → N re-reconciles → N new bursts (thundering-herd amplification).
 */
function watchSessionCompletion(managed: ManagedAutoScaler, sessionId: number): void {
  /** Debounce window: collapses simultaneous session deaths into one reconcile. */
  const COMPLETION_RECONCILE_DEBOUNCE_MS = 1000;

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

      // Trigger re-reconciliation via a debounced timer so that multiple
      // simultaneous session deaths (all picked up within the same 5s poll window)
      // coalesce into a single reconcile pass.
      if (!managed.abortController.signal.aborted) {
        if (managed.completionReconcileTimer !== null) {
          // Another death already set up a pending reconcile — reset the timer
          // so we wait from the latest death rather than the earliest one.
          clearTimeout(managed.completionReconcileTimer);
        }
        managed.completionReconcileTimer = setTimeout(() => {
          managed.completionReconcileTimer = null;
          if (!managed.abortController.signal.aborted) {
            reconcile(managed).catch(() => {});
          }
        }, COMPLETION_RECONCILE_DEBOUNCE_MS);
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
  // Guard against concurrent async ticks: Node.js setInterval does not wait for an async
  // callback to finish before firing the next tick. If getNonDoneTaskCount (an async DB call)
  // takes longer than POLL_MS to return (e.g. a Neo4j latency spike), multiple ticks could
  // run simultaneously, leading to double stopSession calls or a dead idle watcher if one tick
  // clears the interval while another is suspended at an await. This flag ensures only one tick
  // is active at a time.
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

      const allSessions = getAllSessions(autoScaler.userId);
      const session = allSessions.find((s) => s.id === sessionId);

      if (!session || session.status !== "running") {
        // Session is gone — nothing to do, watchSessionCompletion handles cleanup.
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
        // No non-done tasks left — check abort before proceeding, since stopAutoScaler
        // may have been called concurrently during the DB await above.
        if (managed.abortController.signal.aborted) {
          clearInterval(pollInterval);
          managed.idleIntervals.delete(pollInterval);
          return;
        }
      }

      // Stop this idle session.
      clearInterval(pollInterval);
      managed.idleIntervals.delete(pollInterval);
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
 *
 * Note: when keepWarmWhileTasksExist=true, the floor session's death when
 * all tasks become "done" is handled by watchSessionIdle (which checks
 * getNonDoneTaskCount on each idle timeout), NOT by this reconcile loop.
 * We rely on FALLBACK_POLL_MS and notifyTaskAvailable() from state changes
 * for all other floor maintenance. No separate "task done" notification
 * is needed here — the idle timer is the documented mechanism for floor
 * session death once all tasks are complete.
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
