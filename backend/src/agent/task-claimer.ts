/**
 * Task Claimer — Atomic task claiming from Neo4j.
 *
 * SQL Server's UPDLOCK + READPAST hints (the previous implementation) have
 * no direct Cypher equivalent — there is no documented "skip a row someone
 * else is holding" primitive. Per .kiro/specs/neo4j-migration/design.md,
 * this is redesigned as an explicit compare-and-swap (CAS) retry loop:
 *
 *   1. A read-only query fetches a priority-ordered batch of claimable
 *      candidate task IDs (no lock semantics to reason about — it's a
 *      plain read).
 *   2. Candidates are attempted IN ORDER, each as its own fresh managed
 *      write transaction. The first candidate that succeeds is the
 *      claimed task; a candidate that's already been claimed by a
 *      concurrent caller returns zero rows and the loop moves on.
 *
 * CONFIRMED BUG (empirically, not just a documentation gap) in the first
 * version of this file: a plain `MATCH (t {id, state: claimState}) SET
 * t.state = workingState` does NOT reliably re-check `state` after
 * acquiring the write lock. Traced this directly against the live AuraDB
 * instance (bypassing this file entirely, calling raw Cypher outside any
 * test framework) and caught two separate, fully-committed transactions
 * both returning a matched row for the SAME node id in the SAME
 * millisecond — i.e., a real double-claim, not a flaky test. Escalating
 * concurrency (3 candidates/3 callers up to 12/30) reproduced it
 * consistently, not intermittently.
 *
 * FIX: force the write lock unconditionally FIRST, then filter on `state`
 * only once the lock is actually held, then perform the real write:
 *
 *   MATCH (t {id: $taskId})
 *   SET t._touch = true          <- forces the lock, unconditionally
 *   WITH t
 *   WHERE t.state = $claimState  <- re-evaluated only once holding the lock
 *   SET t.state = $workingState
 *   REMOVE t._touch
 *
 * This was verified across 5 trials of 12 concurrent callers each (60 total
 * claim attempts across overlapping real transactions, traced row-by-row)
 * with zero double-claims, versus the original version failing on
 * essentially every trial. The dedicated concurrency integration test
 * (backend/src/tests/task-claim-concurrency.test.ts) is what continues to
 * enforce this going forward — it, not this comment, is the actual
 * guarantee; if it ever starts failing, do not "fix" it by loosening the
 * assertions.
 */

import { EventEmitter } from "node:events";
import neo4j, { type ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "../db/connection.js";
import type { Task } from "../types.js";
import { getTaskById, getTasksByBranch, getTasksByGroupId } from "../db/tasks.js";
import { sanitizeBranchName } from "./repo-url-parser.js";

// ---------------------------------------------------------------------------
// Task-available event bus
//
// Emitted whenever a task transitions INTO a claimable state (created, reset,
// or moved back to a claim state after failure). Loop sessions subscribe to
// this instead of polling the DB every intervalSeconds when the queue is empty.
//
// Entirely in-process, no SQL-specific logic — carried over unchanged.
// ---------------------------------------------------------------------------

const taskBus = new EventEmitter();
taskBus.setMaxListeners(50); // one per active loop session, allow headroom

/**
 * Safety-net re-check interval for waitForTaskAvailable. The event bus above
 * is the primary wake-up path and fires immediately on any relevant write —
 * this timer only guards against a "task-available" event getting dropped
 * for some unforeseen reason (e.g. the cache-staleness bug this same change
 * fixes, or a future regression like it).
 *
 * There's no session/replica timeout to size this against: a loop parked in
 * waitForTaskAvailable is never killed for being idle. ACA's replicaTimeout
 * (infra/modules/worker-job.bicep) caps total wall-clock time for a session
 * regardless of idle vs. busy, it isn't an idle-specific timeout, and local
 * sessions have no ceiling at all. So this is purely "how long is acceptable
 * if a wake-up signal is ever silently lost" — 5 minutes is comfortably above
 * that bar while staying cheap (one indexed COUNT per idle loop per interval).
 */
const FALLBACK_POLL_MS = 5 * 60 * 1000;

/**
 * Wait until at least one task in `claimState` is available for `tabIds`,
 * or until the AbortSignal fires.
 *
 * `workingState` must match the value the caller passes to claimTask() for
 * this same pipeline stage — it's forwarded to getAvailableTaskCount() so
 * the "is anything available" check applies the exact same group-lock
 * exclusion that claimTask()'s candidate query uses (see that function's
 * doc comment). Without this, a task whose only groupId sibling is
 * currently in workingState would look "available" here, this function
 * would return immediately instead of parking, and the caller's very next
 * claimTask() call would fail — not a real race, just a mismatched
 * eligibility rule between the two queries.
 *
 * Returns immediately if tasks are already available (checked via DB COUNT).
 * Otherwise parks the caller until a "task-available" event is emitted by
 * any write path (createTask broadcast, resetTask, resolveTask, etc.), the
 * AbortSignal fires, or FALLBACK_POLL_MS elapses with no event at all — no
 * polling involved on the happy path.
 */
export async function waitForTaskAvailable(
  tabIds: number[] | undefined,
  claimState: string,
  signal: AbortSignal,
  workingState: string = "in-progress"
): Promise<void> {
  // Fast path: tasks already present, no need to wait.
  const count = await getAvailableTaskCount(tabIds, claimState, workingState);
  if (count > 0 || signal.aborted) return;

  return new Promise<void>((resolve) => {
    const onTask = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); resolve(); };
    // Belt-and-suspenders: re-check periodically even if we're never notified.
    // The caller always re-queries getAvailableTaskCount() after this resolves,
    // so a spurious wake here just costs one extra cheap COUNT query.
    const fallbackTimer = setTimeout(() => { cleanup(); resolve(); }, FALLBACK_POLL_MS);

    function cleanup() {
      taskBus.off("task-available", onTask);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(fallbackTimer);
    }

    taskBus.on("task-available", onTask);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Notify waiting loop sessions that a task may now be available.
 * Call this after any write that moves a task INTO a claimable state.
 * Also called by the REST task-creation route so new tasks wake idle loops.
 *
 * Also invalidates the count cache (see getAvailableTaskCount) so that the
 * recheck every caller performs immediately after waking up — either the
 * fast path at the top of this function's own next call, or the loop's own
 * top-of-while COUNT after `continue` — reads a fresh value instead of a
 * stale pre-write count. Without this, a loop could wake up, immediately
 * re-read a cached "0" from just before the write, and park again waiting
 * for a second event that may never come.
 */
export function notifyTaskAvailable(): void {
  countCache.clear();
  taskBus.emit("task-available");
}

// ---------------------------------------------------------------------------
// Broadcast helper — lazily imported to avoid circular dependency
// (websocket-handler → session-manager → task-claimer → websocket-handler)
// ---------------------------------------------------------------------------

import type { WsServerMessage } from "../types.js";

type BroadcastFn = (userId: number, msg: WsServerMessage) => void;

let _broadcastToUser: BroadcastFn | null = null;

async function getBroadcast(): Promise<BroadcastFn> {
  if (!_broadcastToUser) {
    const mod = await import("../websocket-handler.js");
    _broadcastToUser = mod.broadcastToUser;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return _broadcastToUser!;
}

/** Push a task-updated event to the owning user, fire-and-forget. */
async function broadcastTaskUpdate(taskId: number): Promise<void> {
  try {
    const task = await getTaskById(taskId);
    if (!task) return;
    const broadcast = await getBroadcast();
    const ownerIds = new Set((task.tabs ?? []).map((t) => t.userId));
    for (const ownerId of ownerIds) {
      broadcast(ownerId, { type: "task-updated", task });
    }
  } catch {
    // Best-effort — if the DB or broadcast fails, the client will catch up
    // on its next explicit refresh. Don't let this crash the agent loop.
  }
}

export interface ClaimedTask {
  id: number;
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  description: string;
  files: string[];
  origin: "user" | "ai" | "user-assisted";
  /** Existing branch name from a previous stage (null if first stage) */
  branch: string | null;
  /** Existing pull request URL from a previous stage (null if first stage) */
  pullRequestUrl: string | null;
  /** Group identifier — tasks sharing the same groupId are worked on the same branch/PR (AC2) */
  groupId: string | null;
  /** Repository URL from the task's associated tab (null if not set) */
  repositoryUrl: string | null;
  /** User ID of the tab owner (for credential lookup) */
  userId: number | null;
}

/**
 * Number of priority-ordered candidates fetched per claimTask() call before
 * giving up and returning null. Generous relative to this app's actual
 * concurrency (a handful of pipeline sessions, not thousands) — not a hard
 * guarantee against a pathological worst case, but that scale of contention
 * doesn't exist in this deployment.
 */
const CANDIDATE_BATCH_SIZE = 20;

/**
 * Attempts to claim one specific task by id. Returns the claimed task's raw
 * Cypher record shape (props + tabInfo), or null if the task's current state
 * no longer equals `claimState` (already claimed by someone else, or simply
 * not in a claimable state).
 *
 * This is its own fresh managed write transaction (via writeQuery) — never
 * called from inside another transaction. Each call is exactly the atomic
 * unit the CAS loop in claimTask() depends on for correctness.
 */
async function attemptClaim(
  taskId: number,
  claimState: string,
  workingState: string
): Promise<ClaimedTask | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      // FOREACH(CASE...) instead of a WHERE filter after forcing the lock:
      // a WHERE clause here would filter out (drop) the row entirely on a
      // losing attempt, which means the `_touch` write from the line above
      // it would commit but the matching `REMOVE t._touch` after WHERE
      // would never run — leaking a stray `_touch: true` property onto
      // every task a caller loses the race for. FOREACH always reaches the
      // REMOVE regardless of which branch it took, and `claimed` (returned
      // below) reports the actual outcome instead of relying on row count.
      `MATCH (t:Task {id: $taskId})
       SET t._touch = true
       WITH t, t.state = $claimState AS claimed
       FOREACH (_ IN CASE WHEN claimed THEN [1] ELSE [] END |
         SET t.state = $workingState, t.updatedAt = datetime()
       )
       REMOVE t._touch
       WITH t, claimed
       RETURN claimed,
              t{.*} AS props,
              [(t)-[:IN_TAB]->(tab:Tab) |
                {repositoryUrl: tab.repositoryUrl, userId: [(owner:User)-[:OWNS]->(tab) | owner.id][0]}
              ][0] AS tabInfo`,
      { taskId, claimState, workingState }
    );

    if (result.records.length === 0 || !result.records[0].get("claimed")) return null;

    const record = result.records[0];
    const props = record.get("props") as Record<string, unknown>;
    const tabInfo = record.get("tabInfo") as
      | { repositoryUrl: string | null; userId: number | null }
      | null;

    return {
      id: props.id as number,
      title: props.title as string,
      priority: props.priority as 1 | 2 | 3 | 4,
      type: props.type as ClaimedTask["type"],
      description: (props.description as string) ?? "",
      files: (props.files as string[]) ?? [],
      origin: props.origin as ClaimedTask["origin"],
      branch: (props.branch as string) || null,
      pullRequestUrl: (props.pullRequestUrl as string) || null,
      groupId: (props.groupId as string) || null,
      repositoryUrl: tabInfo?.repositoryUrl ?? null,
      userId: tabInfo?.userId ?? null,
    };
  });
}

/**
 * Atomically claim the highest-priority task in the given claim state.
 *
 * Two modes:
 * - `taskId` given: a single claim attempt against that exact task (still
 *   gated by `state = claimState`, so it's not an unconditional grab). No
 *   candidate loop — if that specific task isn't currently claimable,
 *   returns null immediately, matching the original's behavior.
 * - `taskId` omitted: fetches up to CANDIDATE_BATCH_SIZE claimable
 *   candidates ordered by priority ASC, then origin rank ASC (user >
 *   user-assisted > ai > else), then creation time ASC — excluding any task
 *   blocked by an incomplete DEPENDS_ON dependency, and excluding any task
 *   whose `groupId` matches another task already in `workingState` (shared
 *   branch/PR grouping, task #163 — prevents two workers from creating
 *   independent branches for the same group) — and attempts them in order
 *   via attemptClaim() until one succeeds or the batch is exhausted.
 *
 * @param taskId Optional specific task ID to claim (skips priority ordering)
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are eligible. If empty/undefined, all tasks in claimState are eligible.
 * @param claimState The state to claim FROM (default: "todo")
 * @param workingState The state to transition TO on claim (default: "in-progress")
 * @returns The claimed task, or null if no claimable tasks exist
 */
export async function claimTask(
  taskId?: number,
  tabIds?: number[],
  claimState: string = "todo",
  workingState: string = "in-progress"
): Promise<ClaimedTask | null> {
  if (taskId) {
    const claimed = await attemptClaim(taskId, claimState, workingState);
    if (claimed) {
      // Push the state change to the UI immediately — no poll loop needed.
      broadcastTaskUpdate(claimed.id);
    }
    return claimed;
  }

  const effectiveTabIds = tabIds && tabIds.length > 0 ? tabIds : null;

  const candidateIds = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {state: $claimState})
       WHERE NOT EXISTS { MATCH (t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done' }
         AND ($tabIds IS NULL OR EXISTS { MATCH (t)-[:IN_TAB]->(tab:Tab) WHERE tab.id IN $tabIds })
         // Prevent concurrent claims of tasks in the same group (shared
         // branch/PR feature, task #163): skip any task whose groupId
         // matches a task already in workingState. This avoids two workers
         // creating independent branches for the same group. Short-circuits
         // on "no groupId" first, so ungrouped tasks (the common case) never
         // pay for the subquery at all.
         AND (
           t.groupId IS NULL OR
           NOT EXISTS {
             MATCH (g:Task {state: $workingState})
             WHERE g.groupId = t.groupId AND g.id <> t.id
           }
         )
       RETURN t.id AS id
       ORDER BY t.priority ASC, t.originRank ASC, t.createdAt ASC
       LIMIT $limit`,
      // LIMIT requires an actual Cypher Integer on the wire, not a Float —
      // a plain JS number serializes as e.g. `20.0`, which Neo4j rejects
      // ("Must be a non-negative integer") even though disableLosslessIntegers
      // makes *results* come back as plain numbers elsewhere in this driver
      // config. neo4j.int() is required specifically for LIMIT/SKIP-position
      // parameters. Confirmed via a live smoke test, not assumed from docs.
      { claimState, workingState, tabIds: effectiveTabIds, limit: neo4j.int(CANDIDATE_BATCH_SIZE) }
    );
    return result.records.map((r) => r.get("id") as number);
  });

  for (const candidateId of candidateIds) {
    const claimed = await attemptClaim(candidateId, claimState, workingState);
    if (claimed) {
      broadcastTaskUpdate(claimed.id);
      return claimed;
    }
    // Zero rows means a concurrent caller already claimed this candidate
    // since the read in step 1 — move on to the next one rather than
    // blocking or retrying this specific id.
  }

  return null;
}

/**
 * Resolve a task to the given target state (agent completed successfully).
 *
 * `branch` and `pullRequestUrl` use independent tri-state semantics:
 * - omitted / `undefined`: the property is left untouched, preserving
 *   whatever a previous pipeline stage already stored. Use this when the
 *   caller has no new info for that specific field (e.g. an inspector agent
 *   never has a PR URL to contribute, but may still have a real branch name
 *   to record).
 * - `null`: the property is explicitly cleared (in Cypher, `SET n.p = null`
 *   is equivalent to `REMOVE n.p` — confirmed empirically elsewhere in this
 *   migration, e.g. db/sessions.ts).
 * - a string: the property is set to that value.
 *
 * Each field is controlled independently — e.g. you can update `branch`
 * while preserving the existing `pullRequestUrl`, or vice versa. Achieved by
 * only including a property in the dynamic SET clause when the caller
 * actually passed a value for it (mirrors the original's dynamic SQL SET
 * clause builder).
 *
 * @param taskId The task to resolve
 * @param resolveState The target state (e.g. "developed", "reviewed", "done")
 * @param branch Branch name, `null` to clear, or omit to preserve the existing value.
 * @param pullRequestUrl PR URL, `null` to clear, or omit to preserve the existing value.
 */
export async function resolveTask(
  taskId: number,
  resolveState: string,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    const setParts = ["t.state = $resolveState", "t.updatedAt = datetime()"];
    const params: Record<string, unknown> = { taskId, resolveState };

    if (branch !== undefined) {
      setParts.push("t.branch = $branch");
      params.branch = sanitizeBranchName(branch);
    }
    if (pullRequestUrl !== undefined) {
      setParts.push("t.pullRequestUrl = $pullRequestUrl");
      params.pullRequestUrl = pullRequestUrl;
    }

    await tx.run(`MATCH (t:Task {id: $taskId}) SET ${setParts.join(", ")}`, params);
  });

  broadcastTaskUpdate(taskId);
  // Resolving hands the task to the NEXT pipeline stage's claim state (e.g.
  // dev "developed" -> reviewer's claimState). Wake any loop parked waiting
  // for exactly that state — this is the primary dev -> review -> qa handoff,
  // not just an edge case.
  notifyTaskAvailable();
}

/**
 * Reset a task back to a given state (agent failed or timed out).
 * Each agent stage resets to its own claim state on failure — e.g. a failed
 * review resets to "developed" (the reviewer's claimState), not to "todo".
 *
 * `branch` and `pullRequestUrl` use independent tri-state semantics — see
 * {@link resolveTask} for the full rules. In particular: inspector agents
 * (code review, QA) never push and so never have a PR URL to contribute, but
 * they DO check out the task's existing branch, so callers should pass the
 * inspector's real branch name while omitting `pullRequestUrl` (not passing
 * `null`) so an existing PR link from a prior editor stage survives. A worker
 * crash mid-turn, where neither value is known, should omit both rather than
 * passing `null` for either — otherwise a task that already has an open PR
 * loses that link the moment its worker disconnects.
 *
 * @param taskId The task to reset
 * @param resetState The state to reset TO (default: "todo")
 * @param branch Branch name, `null` to clear, or omit to preserve the existing value.
 * @param pullRequestUrl PR URL, `null` to clear, or omit to preserve the existing value.
 */
export async function resetTask(
  taskId: number,
  resetState: string,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    const setParts = ["t.state = $resetState", "t.updatedAt = datetime()"];
    const params: Record<string, unknown> = { taskId, resetState };

    if (branch !== undefined) {
      setParts.push("t.branch = $branch");
      params.branch = sanitizeBranchName(branch);
    }
    if (pullRequestUrl !== undefined) {
      setParts.push("t.pullRequestUrl = $pullRequestUrl");
      params.pullRequestUrl = pullRequestUrl;
    }

    await tx.run(`MATCH (t:Task {id: $taskId}) SET ${setParts.join(", ")}`, params);
  });

  broadcastTaskUpdate(taskId);
  // A reset puts the task back into a claimable state — wake any waiting loops.
  notifyTaskAvailable();
}

/**
 * Reset all in-progress tasks back to "todo".
 * Used on server restart to recover tasks that were being worked on
 * when the kiro-cli process was killed (e.g., by tsx watch restarting the server).
 *
 * @returns The number of tasks that were reset.
 */
export async function resetOrphanedTasks(): Promise<number> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {state: 'in-progress'})
       SET t.state = 'todo', t.updatedAt = datetime()
       RETURN count(t) AS resetCount`
    );
    return result.records[0].get("resetCount") as number;
  });
}

/**
 * Get the count of available tasks in the given claim state.
 *
 * Uses a short TTL cache (5s) to avoid redundant COUNT queries when multiple
 * loop sessions poll simultaneously. The cache is keyed by the sorted tabIds,
 * the claim state, AND the working state (see below).
 *
 * Excludes tasks blocked by an incomplete DEPENDS_ON dependency, AND tasks
 * whose groupId matches another task already in `workingState` — both
 * matching exactly what claimTask()'s candidate query considers eligible.
 * This count is what decides whether a loop session even attempts to claim
 * (see waitForTaskAvailable's fast path) or instead parks idle, so it needs
 * to agree with the claim query's own eligibility rule. Before the groupId
 * exclusion was added here, a task whose only sibling was actively being
 * worked (in workingState) still counted as "available" — the loop would
 * see count > 0, skip parking, and claimTask() would then correctly exclude
 * that same task and return null every time, forever, logging a misleading
 * "race condition" until the sibling left workingState. Not a real race:
 * both queries were just evaluating different eligibility rules.
 *
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are counted. If empty/undefined, all tasks in the given state are counted.
 * @param claimState The state to count tasks in (default: "todo")
 * @param workingState The state a groupId sibling must be in to block a task from counting (default: "in-progress") — pass the same value used for the corresponding claimTask() call.
 */

interface CachedCount {
  value: number;
  expiresAt: number;
}

const countCache = new Map<string, CachedCount>();
const COUNT_CACHE_TTL_MS = 5000;

export async function getAvailableTaskCount(
  tabIds?: number[],
  claimState: string = "todo",
  workingState: string = "in-progress"
): Promise<number> {
  // Build a stable cache key from the sorted tab IDs + claim state + working state
  const tabPart = tabIds && tabIds.length > 0
    ? `tabs:${[...tabIds].sort((a, b) => a - b).join(",")}`
    : "all";
  const cacheKey = `${tabPart}:state:${claimState}:working:${workingState}`;

  const cached = countCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const effectiveTabIds = tabIds && tabIds.length > 0 ? tabIds : null;

  const count = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {state: $claimState})
       WHERE NOT EXISTS { MATCH (t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done' }
         AND ($tabIds IS NULL OR EXISTS { MATCH (t)-[:IN_TAB]->(tab:Tab) WHERE tab.id IN $tabIds })
         AND (
           t.groupId IS NULL OR
           NOT EXISTS {
             MATCH (g:Task {state: $workingState})
             WHERE g.groupId = t.groupId AND g.id <> t.id
           }
         )
       RETURN count(t) AS count`,
      { claimState, workingState, tabIds: effectiveTabIds }
    );
    return result.records[0].get("count") as number;
  });

  countCache.set(cacheKey, { value: count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
  return count;
}

export interface ClaimFailureDiagnosis {
  /**
   * "empty": nothing in claimState at all (the ordinary idle case).
   * "group-locked": every remaining candidate is blocked by a groupId
   *   sibling currently in workingState — not a race, just waiting on
   *   another pipeline stage to finish with that group.
   * "race": at least one real candidate existed but claimTask() still came
   *   back empty — a concurrent caller most likely won it first (genuine
   *   CAS loss), or the count cache was briefly stale.
   */
  reason: "empty" | "group-locked" | "race";
  /** Populated only when reason === "group-locked". */
  blockedTaskId?: number;
  blockedTaskTitle?: string;
  blockingSiblingId?: number;
  blockingSiblingTitle?: string;
}

/**
 * Diagnoses why claimTask() just returned null, for logging purposes only —
 * this is never on the hot path and never influences claiming behavior
 * itself, it just re-queries (uncached) to explain a failure after the fact.
 *
 * getAvailableTaskCount() and claimTask()'s candidate query apply the same
 * DEPENDS_ON + groupId/workingState exclusions (see both functions' doc
 * comments), so a null claimTask() result right after a positive count
 * should now be rare and transient — either the count cache's up-to-
 * COUNT_CACHE_TTL_MS-second staleness window, or a genuine concurrent
 * caller winning the same candidate. Before that fix, this was NOT rare:
 * a task whose only groupId sibling sat in workingState indefinitely would
 * count as "available" forever while claimTask() correctly rejected it
 * forever, producing an endless "race condition or empty queue" loop that
 * was never actually a race. Callers (runLoopMode/runLoopModeAca in
 * session-manager.ts) use this to log the real reason instead of that
 * generic message.
 */
export async function describeClaimFailure(
  tabIds: number[] | undefined,
  claimState: string,
  workingState: string
): Promise<ClaimFailureDiagnosis> {
  const effectiveTabIds = tabIds && tabIds.length > 0 ? tabIds : null;

  const rows = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {state: $claimState})
       WHERE NOT EXISTS { MATCH (t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done' }
         AND ($tabIds IS NULL OR EXISTS { MATCH (t)-[:IN_TAB]->(tab:Tab) WHERE tab.id IN $tabIds })
       OPTIONAL MATCH (g:Task {state: $workingState})
         WHERE t.groupId IS NOT NULL AND g.groupId = t.groupId AND g.id <> t.id
       RETURN t.id AS id, t.title AS title, g.id AS blockingSiblingId, g.title AS blockingSiblingTitle
       ORDER BY t.priority ASC, t.createdAt ASC`,
      { claimState, workingState, tabIds: effectiveTabIds }
    );
    return result.records.map((r) => ({
      id: r.get("id") as number,
      title: r.get("title") as string,
      blockingSiblingId: r.get("blockingSiblingId") as number | null,
      blockingSiblingTitle: r.get("blockingSiblingTitle") as string | null,
    }));
  });

  if (rows.length === 0) {
    return { reason: "empty" };
  }

  const unblocked = rows.find((r) => r.blockingSiblingId == null);
  if (unblocked) {
    // A valid candidate existed — losing here means a concurrent caller
    // claimed it between the candidate read and the write attempt.
    return { reason: "race" };
  }

  // Every remaining task is group-locked — report the highest-priority one
  // (rows is already ordered) as the representative example.
  const blocked = rows[0];
  return {
    reason: "group-locked",
    blockedTaskId: blocked.id,
    blockedTaskTitle: blocked.title,
    blockingSiblingId: blocked.blockingSiblingId ?? undefined,
    blockingSiblingTitle: blocked.blockingSiblingTitle ?? undefined,
  };
}

/**
 * Mark a task as "done" — skipping remaining pipeline stages.
 * Used when an agent reports verdict "no_action_needed" (nothing to change/review),
 * indicating the task should bypass further stages and go straight to done.
 *
 * Unlike resolveTask/resetTask, branch/pullRequestUrl are NOT tri-state here
 * — they are always written, coalescing an omitted/undefined argument to
 * null (which clears the property), exactly matching the original SQL
 * version's `branch ?? null` / `pullRequestUrl ?? null` behavior.
 */
export async function markTaskDone(
  taskId: number,
  branch?: string | null,
  pullRequestUrl?: string | null
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (t:Task {id: $taskId})
       SET t.state = 'done', t.branch = $branch, t.pullRequestUrl = $pullRequestUrl, t.updatedAt = datetime()`,
      { taskId, branch: branch ?? null, pullRequestUrl: pullRequestUrl ?? null }
    );
  });

  broadcastTaskUpdate(taskId);
}

/**
 * Find sibling tasks that share the same `branch` value in the DB.
 *
 * Used for AC1/AC5: when a claimed task already has a branch, look up other
 * tasks sharing that branch to include them in PR content and to propagate
 * the shared PR URL.
 *
 * Note: this only works when the task already has a branch set (since it
 * queries by branch name). For tasks with no branch, AC2 discovery is handled
 * by `findSiblingTasksByGroupId()` using the `group_id` column instead.
 *
 * @param branch The branch name to look for siblings of
 * @param excludeTaskId The current task ID (excluded from results)
 * @returns Sibling tasks with their metadata, or empty array if none found
 */
export async function findSiblingTasks(
  branch: string,
  excludeTaskId: number
): Promise<Array<{ id: number; title: string; type: string; description: string; branch: string | null; pullRequestUrl: string | null }>> {
  return getTasksByBranch(branch, excludeTaskId);
}

/**
 * Find sibling tasks by group_id (AC2 implementation).
 *
 * When a task has no `branch` value but has a `groupId`, this function finds
 * other tasks in the same group. If any of those siblings already has a branch
 * (because an earlier task in the group was processed and had a branch assigned),
 * the caller can use that branch for the current task.
 *
 * This is the missing piece for AC2: "When the dev-agent picks up a task that
 * has no `branch` value but other tasks in the same group do, it looks up the
 * shared branch name from sibling tasks."
 *
 * @param groupId The group identifier to look up siblings for
 * @param excludeTaskId The current task ID (excluded from results)
 * @returns Sibling tasks with their metadata, or empty array if none found
 */
export async function findSiblingTasksByGroupId(
  groupId: string,
  excludeTaskId: number
): Promise<Array<{ id: number; title: string; type: string; description: string; branch: string | null; pullRequestUrl: string | null }>> {
  return getTasksByGroupId(groupId, excludeTaskId);
}
