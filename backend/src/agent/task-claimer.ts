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
 *      write transaction: `MATCH (t {id, state: claimState}) SET
 *      t.state = workingState`. If the task's state no longer equals
 *      claimState (a concurrent caller already claimed it since step 1),
 *      the MATCH filter excludes it and the write returns zero rows — move
 *      to the next candidate rather than blocking or retrying that one.
 *      The first candidate that returns a row is the claimed task.
 *
 * IMPORTANT — this correctness argument rests on one thing that cannot be
 * fully confirmed from Neo4j's documentation alone: whether the `state:
 * claimState` filter in step 2 is re-evaluated against the freshest
 * committed value at write time (correct), or whether a transaction that
 * was blocked on the node's write lock resumes and blindly applies the SET
 * without re-checking the filter once unblocked (would allow a double
 * claim). The design doc flags this explicitly rather than asserting it as
 * settled. This is verified empirically by a dedicated concurrency
 * integration test (backend/src/tests/task-claim-concurrency.test.ts) that
 * fires many simultaneous claimTask() calls against a handful of real tasks
 * on the live AuraDB instance and asserts no task is ever claimed twice —
 * that test, not this file's comments, is the actual guarantee.
 */

import { EventEmitter } from "node:events";
import neo4j, { type ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "../db/connection.js";
import type { Task } from "../types.js";
import { getTaskById } from "../db/tasks.js";

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
 * Returns immediately if tasks are already available (checked via DB COUNT).
 * Otherwise parks the caller until a "task-available" event is emitted by
 * any write path (createTask broadcast, resetTask, resolveTask, etc.), the
 * AbortSignal fires, or FALLBACK_POLL_MS elapses with no event at all — no
 * polling involved on the happy path.
 */
export async function waitForTaskAvailable(
  tabIds: number[] | undefined,
  claimState: string,
  signal: AbortSignal
): Promise<void> {
  // Fast path: tasks already present, no need to wait.
  const count = await getAvailableTaskCount(tabIds, claimState);
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
      `MATCH (t:Task {id: $taskId, state: $claimState})
       SET t.state = $workingState, t.updatedAt = datetime()
       WITH t
       RETURN t{.*} AS props,
              [(t)-[:IN_TAB]->(tab:Tab) |
                {repositoryUrl: tab.repositoryUrl, userId: [(owner:User)-[:OWNS]->(tab) | owner.id][0]}
              ][0] AS tabInfo`,
      { taskId, claimState, workingState }
    );

    if (result.records.length === 0) return null;

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
 *   blocked by an incomplete DEPENDS_ON dependency — and attempts them in
 *   order via attemptClaim() until one succeeds or the batch is exhausted.
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
       RETURN t.id AS id
       ORDER BY t.priority ASC, t.originRank ASC, t.createdAt ASC
       LIMIT $limit`,
      // LIMIT requires an actual Cypher Integer on the wire, not a Float —
      // a plain JS number serializes as e.g. `20.0`, which Neo4j rejects
      // ("Must be a non-negative integer") even though disableLosslessIntegers
      // makes *results* come back as plain numbers elsewhere in this driver
      // config. neo4j.int() is required specifically for LIMIT/SKIP-position
      // parameters. Confirmed via a live smoke test, not assumed from docs.
      { claimState, tabIds: effectiveTabIds, limit: neo4j.int(CANDIDATE_BATCH_SIZE) }
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
      params.branch = branch;
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
      params.branch = branch;
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
 * loop sessions poll simultaneously. The cache is keyed by the sorted tabIds
 * AND the claim state.
 *
 * Excludes tasks blocked by an incomplete DEPENDS_ON dependency, matching
 * exactly what claimTask()'s candidate query considers eligible — this
 * count is what decides whether a loop session even attempts to claim
 * (see waitForTaskAvailable's fast path), so it needs to agree with the
 * claim query's own eligibility rule or a session could see count > 0 from
 * blocked-only tasks, skip waiting, and immediately get null back from
 * claimTask() anyway.
 *
 * @param tabIds Optional tab IDs to filter by — only tasks belonging to at least one of these tabs are counted. If empty/undefined, all tasks in the given state are counted.
 * @param claimState The state to count tasks in (default: "todo")
 */

interface CachedCount {
  value: number;
  expiresAt: number;
}

const countCache = new Map<string, CachedCount>();
const COUNT_CACHE_TTL_MS = 5000;

export async function getAvailableTaskCount(tabIds?: number[], claimState: string = "todo"): Promise<number> {
  // Build a stable cache key from the sorted tab IDs + claim state
  const tabPart = tabIds && tabIds.length > 0
    ? `tabs:${[...tabIds].sort((a, b) => a - b).join(",")}`
    : "all";
  const cacheKey = `${tabPart}:state:${claimState}`;

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
       RETURN count(t) AS count`,
      { claimState, tabIds: effectiveTabIds }
    );
    return result.records[0].get("count") as number;
  });

  countCache.set(cacheKey, { value: count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
  return count;
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
