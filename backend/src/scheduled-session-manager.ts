/**
 * Scheduled Session Manager
 *
 * A single in-process scheduler that arms one timer per cron-configured
 * Session (Looper view). On each cron tick the session runs its prompt
 * exactly once via a one-shot path (start → single turn → stop), then the
 * next timer is re-armed. Scheduled sessions do NOT stay running idle
 * between ticks and are NOT auto-restarted on server boot.
 *
 * The retry/skip decision logic (`runScheduledSessionOnce`) is written as a
 * pure function over an injectable `ScheduledRunDeps` so it can be unit-tested
 * without a real KiroRunner/worker/DB — see scheduled-session-manager.test.ts.
 * The timer-arming layer wires those deps to the real session-manager.
 */

import { computeNextFireDelayMs } from "./cron-schedule.js";
import { log, toErrorFields } from "./logger.js";
import {
  getScheduledSessions,
  getSessionStatus,
  runOneShotTurn,
  appendScheduledSystemLine,
  recordScheduledAttemptError,
} from "./session-manager.js";

// ---------------------------------------------------------------------------
// Pure one-shot run logic (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Dependencies for a single scheduled run — injected so the retry/skip logic
 * can be exercised without any real infrastructure.
 */
export interface ScheduledRunDeps {
  /** Current status of the session ("running", "stopped", ...). */
  getStatus: (sessionId: number) => string;
  /**
   * Run one one-shot attempt: start the session, send its prompt for a single
   * turn, then stop it. Resolves on success, rejects/throws on failure.
   */
  runOneShotAttempt: (sessionId: number) => Promise<void>;
  /** Append a system output line to the session (for the skip notice). */
  appendSystemLine: (sessionId: number, text: string) => void;
  /**
   * Record one AgentError for a failed attempt, tagged with the attempt
   * number out of the total number of attempts.
   */
  recordAttemptError: (attempt: number, totalAttempts: number, err: unknown) => void;
}

export type ScheduledRunResult =
  | { skipped: true }
  | { skipped: false; attempts: number; succeeded: boolean };

/**
 * Run a scheduled session exactly once, honoring `retries`.
 *
 * - If the session is currently running, SKIP the tick: append a system line
 *   and record NO error.
 * - Otherwise attempt the one-shot run up to `retries + 1` times. Each failed
 *   attempt records one AgentError (tagged "attempt N/total"). Retrying stops
 *   early on the first success; earlier failures remain recorded.
 */
export async function runScheduledSessionOnce(
  sessionId: number,
  retries: number,
  deps: ScheduledRunDeps
): Promise<ScheduledRunResult> {
  if (deps.getStatus(sessionId) === "running") {
    deps.appendSystemLine(
      sessionId,
      "Scheduled run skipped — previous run still in progress"
    );
    return { skipped: true };
  }

  const totalAttempts = Math.max(0, retries) + 1;
  let attempts = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    attempts = attempt;
    try {
      await deps.runOneShotAttempt(sessionId);
      return { skipped: false, attempts, succeeded: true };
    } catch (err) {
      deps.recordAttemptError(attempt, totalAttempts, err);
    }
  }

  return { skipped: false, attempts, succeeded: false };
}

// ---------------------------------------------------------------------------
// Timer-arming layer (wires the pure logic to session-manager)
// ---------------------------------------------------------------------------

interface ScheduledEntry {
  sessionId: number;
  cronExpression: string;
  cronTimezone: string;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const armed = new Map<number, ScheduledEntry>();

/**
 * Arm (or re-arm) the timer for a scheduled session. A session with no valid
 * cronExpression/cronTimezone is disarmed instead. Safe to call repeatedly —
 * any existing timer for the session is cleared first.
 */
export function armSession(
  sessionId: number,
  cronExpression: string | undefined,
  cronTimezone: string | undefined,
  retries: number | undefined
): void {
  disarmSession(sessionId);

  if (!cronExpression || !cronTimezone) return;

  const entry: ScheduledEntry = {
    sessionId,
    cronExpression,
    cronTimezone,
    retries: retries ?? 0,
    timer: null,
  };
  armed.set(sessionId, entry);
  scheduleNext(entry);
}

/** Disarm a scheduled session's timer, if any. */
export function disarmSession(sessionId: number): void {
  const existing = armed.get(sessionId);
  if (existing?.timer) clearTimeout(existing.timer);
  armed.delete(sessionId);
}

function scheduleNext(entry: ScheduledEntry): void {
  let delayMs: number;
  try {
    delayMs = computeNextFireDelayMs(entry.cronExpression, entry.cronTimezone);
  } catch (err) {
    log.warn("scheduled-session-arm-failed", {
      component: "scheduled-session-manager",
      sessionId: entry.sessionId,
      ...toErrorFields(err),
      msg: "Could not compute next fire time — disarming",
    });
    disarmSession(entry.sessionId);
    return;
  }

  entry.timer = setTimeout(() => {
    void fire(entry);
  }, delayMs);
}

async function fire(entry: ScheduledEntry): Promise<void> {
  const deps: ScheduledRunDeps = {
    getStatus: (sessionId) => getSessionStatus(sessionId) ?? "stopped",
    runOneShotAttempt: (sessionId) => runOneShotTurn(sessionId),
    appendSystemLine: (sessionId, text) => appendScheduledSystemLine(sessionId, text),
    recordAttemptError: (attempt, total, err) =>
      recordScheduledAttemptError(entry.sessionId, attempt, total, err),
  };

  try {
    await runScheduledSessionOnce(entry.sessionId, entry.retries, deps);
  } catch (err) {
    log.error("scheduled-session-tick-failed", {
      component: "scheduled-session-manager",
      sessionId: entry.sessionId,
      ...toErrorFields(err),
    });
  } finally {
    // Re-arm the next timer after each tick completes, as long as the session
    // is still armed (a disarm during the run wins).
    if (armed.has(entry.sessionId)) {
      scheduleNext(entry);
    }
  }
}

/**
 * Initialize the scheduler at server startup: arm every session that has a
 * cronExpression. Scheduled sessions are one-shot and must not be
 * auto-restarted as "running" — that exclusion lives in initSessions().
 */
export async function initScheduledSessions(): Promise<void> {
  let scheduled: Awaited<ReturnType<typeof getScheduledSessions>> = [];
  try {
    scheduled = await getScheduledSessions();
  } catch (err) {
    log.warn("scheduled-sessions-init-failed", {
      component: "scheduled-session-manager",
      ...toErrorFields(err),
    });
    return;
  }

  for (const s of scheduled) {
    if (s.cronExpression) {
      armSession(s.id, s.cronExpression, s.cronTimezone, s.retries);
    }
  }

  if (scheduled.length > 0) {
    log.info("scheduled-sessions-armed", {
      component: "scheduled-session-manager",
      count: scheduled.length,
      msg: `Armed ${scheduled.length} scheduled session(s)`,
    });
  }
}

/** For tests / shutdown — disarm all timers. */
export function disarmAll(): void {
  for (const id of Array.from(armed.keys())) {
    disarmSession(id);
  }
}

/**
 * Trigger one immediate one-shot run of a session through the same path a cron
 * tick uses (skip-if-running + retry logic). Used by
 * POST /api/sessions/:id/run-now. Does NOT affect the session's armed timer.
 */
export function triggerRunNow(
  sessionId: number,
  retries: number
): Promise<ScheduledRunResult> {
  const deps: ScheduledRunDeps = {
    getStatus: (id) => getSessionStatus(id) ?? "stopped",
    runOneShotAttempt: (id) => runOneShotTurn(id),
    appendSystemLine: (id, text) => appendScheduledSystemLine(id, text),
    recordAttemptError: (attempt, total, err) =>
      recordScheduledAttemptError(sessionId, attempt, total, err),
  };
  return runScheduledSessionOnce(sessionId, retries, deps);
}
