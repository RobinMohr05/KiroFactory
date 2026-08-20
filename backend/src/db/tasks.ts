/**
 * Neo4j-backed implementation of the tasks data-access layer.
 *
 * Every exported function here keeps the exact name, parameter types, and
 * return type it had under the previous mssql-based implementation — see
 * .kiro/specs/neo4j-migration/design.md for the full :Task node model and
 * migration rationale. Two things are genuinely new, not just ported:
 *
 *   - `dependsOn`/`isBlocked`/`blockedBy` (Requirement 2): a task can depend
 *     on other tasks via `(:Task)-[:DEPENDS_ON]->(:Task)`. `isBlocked` is
 *     NEVER stored — it's computed at read time from whether any dependency
 *     is not yet "done", so it can never go stale relative to the actual
 *     dependency states. Writes go through `replaceDependencies` below,
 *     which rejects any write that would introduce a cycle (directly or
 *     transitively) — see Requirement 2.4.
 *   - `originRank` (int property on :Task): a precomputed 0/1/2/3 from
 *     `origin` (user/user-assisted/ai/else), replacing the SQL `CASE` that
 *     used to live inline in the claim query's `ORDER BY`. Set once at
 *     creation — `origin` itself is immutable after creation (there is no
 *     `origin` field on `UpdateTaskInput`), so this never needs recomputing.
 *
 * Every 0-or-more relationship traversal below (dependsOn ids, blockedBy)
 * uses a list comprehension (`[(pattern) | projection]`), not
 * `OPTIONAL MATCH` + `collect()` — the latter produces a false-positive
 * non-empty list (`[{id: null, title: null}]`) when nothing matches,
 * confirmed empirically while rewriting db/tabs.ts in this same migration.
 * List comprehensions don't have that bug (an empty match is genuinely `[]`).
 *
 * Dropped columns: `retry_count`/`max_retries` (confirmed dead — no code
 * path reads them; actual retry logic is in-memory in session-manager.ts).
 */

import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";
import type { Task, CreateTaskInput, UpdateTaskInput } from "../types.js";
import { DEFAULT_MCP_CONFIG, DependencyCycleError, isGitProvider } from "../types.js";

/**
 * Precomputed claim-ordering rank from `origin` — mirrors the SQL `CASE
 * origin WHEN 'user' THEN 0 WHEN 'user-assisted' THEN 1 WHEN 'ai' THEN 2
 * ELSE 3 END` that used to live inline in the claim query. `origin` is
 * immutable after creation, so this is computed exactly once, in createTask.
 */
function computeOriginRank(origin: Task["origin"]): number {
  switch (origin) {
    case "user":
      return 0;
    case "user-assisted":
      return 1;
    case "ai":
      return 2;
    default:
      return 3;
  }
}

/**
 * Map a :Task node's properties plus its resolved dependsOn/blockedBy lists
 * to a Task object. `tabs` is populated separately by attachTabs (batched
 * across multiple tasks), matching the original code's two-step shape.
 */
function mapNodeToTask(
  props: Record<string, unknown>,
  dependsOn: number[],
  blockedBy: Array<{ id: number; title: string }>
): Task {
  return {
    id: props.id as number,
    title: props.title as string,
    priority: props.priority as 1 | 2 | 3 | 4,
    type: props.type as Task["type"],
    state: props.state as string,
    description: (props.description as string) ?? "",
    files: (props.files as string[]) ?? [],
    origin: props.origin as Task["origin"],
    branch: (props.branch as string) || null,
    pullRequestUrl: (props.pullRequestUrl as string) || null,
    groupId: (props.groupId as string) || null,
    // createdAt/updatedAt come back as neo4j-driver DateTime values, not a
    // JS Date — .toString() on those produces an ISO 8601 string directly.
    createdAt: (props.createdAt as { toString(): string }).toString(),
    updatedAt: (props.updatedAt as { toString(): string }).toString(),
    dependsOn,
    isBlocked: blockedBy.length > 0,
    blockedBy,
  };
}

/** The dependsOn/blockedBy list-comprehension fragment, reused by every read below. */
const DEPENDENCY_PROJECTION = `
  [(t)-[:DEPENDS_ON]->(dep:Task) | dep.id] AS dependsOn,
  [(t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done' | {id: dep.id, title: dep.title}] AS blockedBy
`;

/**
 * Attach tab memberships to a list of tasks (batch lookup), mutating each
 * task's `tabs` field in place — mirrors the original mssql-based
 * attachTabs' shape exactly, including its simplifications: mcpConfig is
 * always the default (never the tab's real config) and columns is always
 * `[]`, matching the original's behavior of never fetching those two fields
 * for this particular join. `userId` is resolved via the tab's OWNS
 * relationship (no longer a stored property on :Tab).
 */
async function attachTabs(tx: ManagedTransaction, tasks: Task[]): Promise<void> {
  if (tasks.length === 0) return;

  const taskIds = tasks.map((t) => t.id);
  const result = await tx.run(
    `UNWIND $taskIds AS taskId
     MATCH (t:Task {id: taskId})-[:IN_TAB]->(tab:Tab)
     OPTIONAL MATCH (owner:User)-[:OWNS]->(tab)
     RETURN taskId, tab{.*} AS tabProps, owner.id AS ownerId`,
    { taskIds }
  );

  const tabsByTask = new Map<number, Task["tabs"]>();
  for (const record of result.records) {
    const taskId = record.get("taskId") as number;
    const tabProps = record.get("tabProps") as Record<string, unknown>;
    const ownerId = record.get("ownerId") as number | null;
    if (!tabsByTask.has(taskId)) tabsByTask.set(taskId, []);
    const gitProvider = tabProps.gitProvider as string | null | undefined;
    tabsByTask.get(taskId)!.push({
      id: tabProps.id as number,
      name: tabProps.name as string,
      repositoryUrl: (tabProps.repositoryUrl as string) || null,
      gitProvider: isGitProvider(gitProvider) ? gitProvider : null,
      mcpConfig: { ...DEFAULT_MCP_CONFIG },
      autoMergePrs: !!(tabProps.autoMergePrs),
      columns: [],
      sortOrder: (tabProps.sortOrder as number) ?? 0,
      userId: ownerId ?? 0,
      createdAt: (tabProps.createdAt as { toString(): string }).toString(),
    });
  }

  for (const task of tasks) {
    task.tabs = tabsByTask.get(task.id) ?? [];
  }
}

/**
 * Replaces ALL of a task's outgoing DEPENDS_ON edges with the given set of
 * dependency IDs, rejecting the entire write (no partial application — this
 * always runs inside the caller's writeQuery transaction, so a thrown error
 * here rolls back everything, including the edge removal) if:
 *   - a requested dependency ID doesn't refer to an existing task, or
 *   - the task depends on itself, or
 *   - adding any of the requested edges would close a cycle — i.e. the
 *     candidate dependency can already reach this task via existing
 *     DEPENDS_ON edges (checked via bounded-depth path search, run AFTER
 *     this task's own stale edges are removed, so a task's own outgoing
 *     edges can never count against itself in the check).
 *
 * Existing edges are removed unconditionally first (even for an empty
 * `dependsOn`, which correctly clears all dependencies) — validation and
 * recreation only run when there's something new to add.
 */
async function replaceDependencies(
  tx: ManagedTransaction,
  taskId: number,
  dependsOn: number[]
): Promise<void> {
  await tx.run(`MATCH (a:Task {id: $taskId})-[r:DEPENDS_ON]->(:Task) DELETE r`, { taskId });

  const depIds = Array.from(new Set(dependsOn));
  if (depIds.length === 0) return;

  if (depIds.includes(taskId)) {
    throw new DependencyCycleError(taskId, taskId);
  }

  const existsResult = await tx.run(
    `UNWIND $depIds AS depId
     OPTIONAL MATCH (b:Task {id: depId})
     WITH depId, b
     WHERE b IS NULL
     RETURN collect(depId) AS missingIds`,
    { depIds }
  );
  const missingIds = existsResult.records[0].get("missingIds") as number[];
  if (missingIds.length > 0) {
    throw new Error(`Cannot depend on nonexistent task id(s): ${missingIds.join(", ")}`);
  }

  // Cycle check: for each candidate dependency b, adding a->b would close a
  // cycle only if b can already reach a via existing DEPENDS_ON edges
  // (evaluated against the graph as it stands after this task's own old
  // edges were removed above).
  const cycleResult = await tx.run(
    `MATCH (a:Task {id: $taskId})
     UNWIND $depIds AS depId
     MATCH (b:Task {id: depId})
     OPTIONAL MATCH path = (b)-[:DEPENDS_ON*1..50]->(a)
     WITH depId, path
     WHERE path IS NOT NULL
     RETURN collect(depId) AS cyclicIds`,
    { taskId, depIds }
  );
  const cyclicIds = cycleResult.records[0].get("cyclicIds") as number[];
  if (cyclicIds.length > 0) {
    throw new DependencyCycleError(taskId, cyclicIds[0]);
  }

  await tx.run(
    `MATCH (a:Task {id: $taskId})
     UNWIND $depIds AS depId
     MATCH (b:Task {id: depId})
     MERGE (a)-[:DEPENDS_ON]->(b)`,
    { taskId, depIds }
  );
}

/** Re-fetches a single task (props + dependsOn/blockedBy) within the caller's transaction. */
async function fetchTaskCore(
  tx: ManagedTransaction,
  taskId: number
): Promise<{ props: Record<string, unknown>; dependsOn: number[]; blockedBy: Array<{ id: number; title: string }> } | null> {
  const result = await tx.run(
    `MATCH (t:Task {id: $taskId}) RETURN t{.*} AS props, ${DEPENDENCY_PROJECTION}`,
    { taskId }
  );
  if (result.records.length === 0) return null;
  const record = result.records[0];
  return {
    props: record.get("props"),
    dependsOn: record.get("dependsOn"),
    blockedBy: record.get("blockedBy"),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isTaskOwnedByUser(taskId: number, userId: number): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {id: $taskId})-[:IN_TAB]->(:Tab)<-[:OWNS]-(:User {id: $userId}) RETURN t LIMIT 1`,
      { taskId, userId }
    );
    return result.records.length > 0;
  });
}

export async function getAllTasks(
  filters?: { state?: string; priority?: number; tabId?: number; userId?: number }
): Promise<Task[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task)
       WHERE ($state IS NULL OR t.state = $state)
         AND ($priority IS NULL OR t.priority = $priority)
         AND ($tabId IS NULL OR EXISTS { (t)-[:IN_TAB]->(:Tab {id: $tabId}) })
         AND ($userId IS NULL OR EXISTS { (t)-[:IN_TAB]->(:Tab)<-[:OWNS]-(:User {id: $userId}) })
       RETURN t{.*} AS props, ${DEPENDENCY_PROJECTION}
       ORDER BY t.priority ASC, t.createdAt DESC`,
      {
        state: filters?.state ?? null,
        priority: filters?.priority ?? null,
        tabId: filters?.tabId ?? null,
        userId: filters?.userId ?? null,
      }
    );
    const tasks = result.records.map((r) =>
      mapNodeToTask(r.get("props"), r.get("dependsOn"), r.get("blockedBy"))
    );
    await attachTabs(tx, tasks);
    return tasks;
  });
}

export async function getTaskById(id: number): Promise<Task | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const core = await fetchTaskCore(tx, id);
    if (!core) return null;
    const task = mapNodeToTask(core.props, core.dependsOn, core.blockedBy);
    await attachTabs(tx, [task]);
    return task;
  });
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const id = await getNextId("Task");
  const origin = input.origin ?? "user";
  const originRank = computeOriginRank(origin);

  return writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `CREATE (t:Task {
         id: $id, title: $title, priority: $priority, type: $type, state: 'todo',
         description: $description, files: $files, origin: $origin, originRank: $originRank,
         groupId: $groupId, createdAt: datetime(), updatedAt: datetime()
       })
       WITH t
       CALL (t) {
         UNWIND $tabIds AS tabId
         MATCH (tab:Tab {id: tabId})
         CREATE (t)-[:IN_TAB]->(tab)
       }`,
      {
        id,
        title: input.title,
        priority: input.priority,
        type: input.type,
        description: input.description ?? "",
        files: input.files ?? [],
        origin,
        originRank,
        groupId: input.groupId ?? null,
        tabIds: input.tabIds ?? [],
      }
    );

    if (input.dependsOn && input.dependsOn.length > 0) {
      await replaceDependencies(tx, id, input.dependsOn);
    }

    // Re-fetch within the same transaction so dependsOn/blockedBy reflect
    // whatever replaceDependencies just did.
    const core = await fetchTaskCore(tx, id);
    // core is never null here — the CREATE above just committed this exact id.
    const task = mapNodeToTask(core!.props, core!.dependsOn, core!.blockedBy);
    await attachTabs(tx, [task]);
    return task;
  });
}

export async function updateTask(id: number, input: UpdateTaskInput): Promise<Task | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const setParts: string[] = ["t.updatedAt = datetime()"];
    const params: Record<string, unknown> = { id };

    if (input.title !== undefined) {
      setParts.push("t.title = $title");
      params.title = input.title;
    }
    if (input.priority !== undefined) {
      setParts.push("t.priority = $priority");
      params.priority = input.priority;
    }
    if (input.type !== undefined) {
      setParts.push("t.type = $type");
      params.type = input.type;
    }
    if (input.state !== undefined) {
      setParts.push("t.state = $state");
      params.state = input.state;
    }
    if (input.description !== undefined) {
      setParts.push("t.description = $description");
      params.description = input.description;
    }
    if (input.files !== undefined) {
      setParts.push("t.files = $files");
      params.files = input.files;
    }
    if (input.branch !== undefined) {
      setParts.push("t.branch = $branch");
      params.branch = input.branch;
    }
    if (input.pullRequestUrl !== undefined) {
      setParts.push("t.pullRequestUrl = $pullRequestUrl");
      params.pullRequestUrl = input.pullRequestUrl;
    }
    if (input.groupId !== undefined) {
      setParts.push("t.groupId = $groupId");
      params.groupId = input.groupId;
    }

    const updateResult = await tx.run(
      `MATCH (t:Task {id: $id}) SET ${setParts.join(", ")} RETURN t`,
      params
    );
    if (updateResult.records.length === 0) return null;

    if (input.dependsOn !== undefined) {
      await replaceDependencies(tx, id, input.dependsOn);
    }

    const core = await fetchTaskCore(tx, id);
    const task = mapNodeToTask(core!.props, core!.dependsOn, core!.blockedBy);
    await attachTabs(tx, [task]);
    return task;
  });
}

export async function deleteTask(id: number): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    // DETACH DELETE removes every relationship touching this node in both
    // directions — including any OTHER task's DEPENDS_ON edge pointing AT
    // this one, so nothing is left permanently blocked on a dependency that
    // no longer exists.
    const result = await tx.run(
      `MATCH (t:Task {id: $id}) DETACH DELETE t RETURN count(t) AS deletedCount`,
      { id }
    );
    return (result.records[0]?.get("deletedCount") as number) > 0;
  });
}

export async function assignTaskToTabs(taskId: number, tabIds: number[]): Promise<Task | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const taskCheck = await tx.run(`MATCH (t:Task {id: $taskId}) RETURN t`, { taskId });
    if (taskCheck.records.length === 0) return null;

    await tx.run(`MATCH (t:Task {id: $taskId})-[r:IN_TAB]->(:Tab) DELETE r`, { taskId });
    await tx.run(
      `MATCH (t:Task {id: $taskId})
       UNWIND $tabIds AS tabId
       MATCH (tab:Tab {id: tabId})
       MERGE (t)-[:IN_TAB]->(tab)`,
      { taskId, tabIds }
    );

    const core = await fetchTaskCore(tx, taskId);
    const task = mapNodeToTask(core!.props, core!.dependsOn, core!.blockedBy);
    await attachTabs(tx, [task]);
    return task;
  });
}

export async function removeTaskFromTab(taskId: number, tabId: number): Promise<Task | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const delResult = await tx.run(
      `MATCH (t:Task {id: $taskId})-[r:IN_TAB]->(:Tab {id: $tabId})
       DELETE r
       RETURN count(r) AS deletedCount`,
      { taskId, tabId }
    );
    if ((delResult.records[0]?.get("deletedCount") as number) === 0) return null;

    const core = await fetchTaskCore(tx, taskId);
    const task = mapNodeToTask(core!.props, core!.dependsOn, core!.blockedBy);
    await attachTabs(tx, [task]);
    return task;
  });
}

export async function getChangedTasksSince(since: string): Promise<Task[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task)
       WHERE t.updatedAt > datetime($since)
       RETURN t{.*} AS props, ${DEPENDENCY_PROJECTION}
       ORDER BY t.updatedAt ASC`,
      { since }
    );
    const tasks = result.records.map((r) =>
      mapNodeToTask(r.get("props"), r.get("dependsOn"), r.get("blockedBy"))
    );
    await attachTabs(tx, tasks);
    return tasks;
  });
}

/**
 * Set the branch and pull request URL on a task.
 * Used internally by the agent lifecycle — not exposed through the public update API.
 */
export async function setTaskBranchAndPr(
  taskId: number,
  branch: string | null,
  pullRequestUrl: string | null
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (t:Task {id: $taskId})
       SET t.branch = $branch, t.pullRequestUrl = $pullRequestUrl, t.updatedAt = datetime()`,
      { taskId, branch, pullRequestUrl }
    );
  });
}

/**
 * Find all tasks that share the same branch value as a given task.
 * Used for the shared branch/PR feature (task #163) — when multiple tasks
 * are grouped on the same branch, the dev-agent should use the existing
 * branch and PR instead of creating new ones.
 *
 * @param branch The branch name to look for
 * @param excludeTaskId Optional task ID to exclude (typically the current task)
 * @returns Tasks sharing that branch (minimal fields: id, title, type, description, branch, pullRequestUrl)
 */
export async function getTasksByBranch(
  branch: string,
  excludeTaskId?: number
): Promise<Array<{ id: number; title: string; type: string; description: string; branch: string | null; pullRequestUrl: string | null }>> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {branch: $branch})
       WHERE $excludeTaskId IS NULL OR t.id <> $excludeTaskId
       RETURN t{.*} AS props
       ORDER BY t.id ASC`,
      { branch, excludeTaskId: excludeTaskId ?? null }
    );
    return result.records.map((r) => {
      const props = r.get("props") as Record<string, unknown>;
      return {
        id: props.id as number,
        title: props.title as string,
        type: props.type as string,
        description: (props.description as string) ?? "",
        branch: (props.branch as string) || null,
        pullRequestUrl: (props.pullRequestUrl as string) || null,
      };
    });
  });
}

/**
 * Find sibling tasks by group_id.
 *
 * Used for AC2 of the shared branch/PR feature: when a task has no `branch`
 * value but has a `group_id`, we can look up other tasks in the same group
 * to discover the shared branch that an earlier task already created.
 *
 * @param groupId The group identifier to search for
 * @param excludeTaskId Optional task ID to exclude from results (the current task)
 * @returns Tasks sharing that group_id (minimal fields: id, title, type, description, branch, pullRequestUrl)
 */
export async function getTasksByGroupId(
  groupId: string,
  excludeTaskId?: number
): Promise<Array<{ id: number; title: string; type: string; description: string; branch: string | null; pullRequestUrl: string | null }>> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {groupId: $groupId})
       WHERE $excludeTaskId IS NULL OR t.id <> $excludeTaskId
       RETURN t{.*} AS props
       ORDER BY t.id ASC`,
      { groupId, excludeTaskId: excludeTaskId ?? null }
    );
    return result.records.map((r) => {
      const props = r.get("props") as Record<string, unknown>;
      return {
        id: props.id as number,
        title: props.title as string,
        type: props.type as string,
        description: (props.description as string) ?? "",
        branch: (props.branch as string) || null,
        pullRequestUrl: (props.pullRequestUrl as string) || null,
      };
    });
  });
}

/**
 * Check if a task's tab has autoMergePrs enabled.
 * Returns true if ANY of the task's tabs has autoMergePrs = true.
 */
export async function getTaskAutoMergePrs(taskId: number): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {id: $taskId})-[:IN_TAB]->(tab:Tab)
       WHERE tab.autoMergePrs = true
       RETURN count(tab) > 0 AS enabled`,
      { taskId }
    );
    if (result.records.length === 0) return false;
    return result.records[0].get("enabled") as boolean;
  });
}

/**
 * Check if all tasks in a group are done (or will be done once the current task resolves).
 * "Done" means state = "done" OR the task is the current one being resolved.
 *
 * @param groupId The group identifier
 * @param currentTaskId The task that is about to be resolved (treated as "done")
 * @returns true if all tasks in the group are done or are the current task
 */
export async function areAllGroupTasksDone(groupId: string, currentTaskId: number): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (t:Task {groupId: $groupId})
       WHERE t.id <> $currentTaskId AND t.state <> 'done'
       RETURN count(t) AS notDoneCount`,
      { groupId, currentTaskId }
    );
    if (result.records.length === 0) return true;
    const count = result.records[0].get("notDoneCount");
    // Neo4j Integer: use toNumber() if it's an Integer object
    const num = typeof count === "object" && count !== null && "toNumber" in count
      ? count.toNumber()
      : Number(count);
    return num === 0;
  });
}
