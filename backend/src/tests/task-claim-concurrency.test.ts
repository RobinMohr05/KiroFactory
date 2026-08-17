/**
 * Concurrency integration test for claimTask() (Requirement 3.6,
 * .kiro/specs/neo4j-migration/design.md).
 *
 * DELIBERATE EXCEPTION to this test suite's usual "mock the DB, no real
 * connection needed" convention (see idle-loop-task-visibility-fixes.test.ts,
 * session-pin-reorder-fixes.test.ts, task-planner-image.test.ts — all
 * mock-based). A mock cannot prove concurrency safety: the whole point of
 * this test is to verify what actually happens when many real network round
 * trips to the real AuraDB instance interleave, which is exactly the
 * behavior a mock stubs away. See task-claimer.ts's own header comment for
 * why this can't be settled from Neo4j's documentation alone — this test,
 * not a code comment, is the actual guarantee that claimTask()'s
 * compare-and-swap redesign (replacing SQL Server's UPDLOCK+READPAST, which
 * has no direct Cypher equivalent) never lets two callers claim the same
 * task.
 *
 * Requires a real, reachable Neo4j instance (backend/.env's NEO4J_* vars —
 * this workspace's accepted convention is that local/test dev shares the
 * same AuraDB Free instance used for production, per
 * .kiro/specs/neo4j-migration/design.md's "Local development environment"
 * section). If NEO4J_URI isn't set, the whole suite is skipped rather than
 * failed, so `npm test` still passes in an environment with no DB access
 * configured at all.
 *
 * All fixtures are tagged with a run-unique prefix and removed in
 * afterAll — this test creates and destroys real data on the shared
 * instance, it does not touch any pre-existing tasks/tabs/users.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";

// describe.skipIf's condition is evaluated synchronously at collection time,
// before any beforeAll runs — so NEO4J_URI must already be in process.env
// by the time this file's top level finishes executing, not merely by the
// time connection.ts gets dynamically imported inside beforeAll below.
// connection.ts calls dotenv.config() itself, but only once it's actually
// imported — deferring that import into beforeAll (as this file otherwise
// does for every other module, to avoid loading the whole db layer when the
// suite is skipped) would make this check always see an empty env and skip
// unconditionally, even with real credentials configured. Loading dotenv
// here directly avoids that ordering trap without needing an eager import
// of the full db layer.
dotenv.config();

const hasNeo4jConfigured = !!process.env.NEO4J_URI;

describe.skipIf(!hasNeo4jConfigured)("claimTask — concurrency safety (live AuraDB integration test)", () => {
  let connection: typeof import("../db/connection.js");
  let usersDb: typeof import("../db/users.js");
  let tabsDb: typeof import("../db/tabs.js");
  let tasksDb: typeof import("../db/tasks.js");
  let taskClaimer: typeof import("../agent/task-claimer.js");

  const TAG = `concurrency-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let userId = -1;
  let tabId = -1;
  const createdTaskIds: number[] = [];

  beforeAll(async () => {
    connection = await import("../db/connection.js");
    usersDb = await import("../db/users.js");
    tabsDb = await import("../db/tabs.js");
    tasksDb = await import("../db/tasks.js");
    taskClaimer = await import("../agent/task-claimer.js");

    const driver = await connection.tryConnect();
    if (!driver) {
      throw new Error(
        "NEO4J_URI is set but the connection failed — this is a real configuration " +
          "problem, not just 'no credentials available', so failing loudly rather than skipping."
      );
    }

    const user = await usersDb.createUser({
      email: `${TAG}@example.com`,
      password: "irrelevant-test-password",
      kiroApiKey: "irrelevant-test-key",
    });
    userId = user.id;

    const tab = await tabsDb.createTab({ name: `${TAG}_tab`, userId });
    tabId = tab.id;
  }, 30000);

  afterAll(async () => {
    for (const id of createdTaskIds) {
      await tasksDb.deleteTask(id).catch(() => {
        /* best-effort cleanup */
      });
    }
    if (tabId > 0) {
      await tabsDb.deleteTab(tabId).catch(() => {
        /* best-effort cleanup */
      });
    }
    if (userId > 0) {
      await usersDb.deleteUser(userId).catch(() => {
        /* best-effort cleanup */
      });
    }
    await connection.closePool();
  }, 30000);

  it(
    "never lets two concurrent callers claim the same task from a shared pool",
    async () => {
      const TASK_COUNT = 12;
      const CONCURRENT_CALLERS = 30; // > TASK_COUNT on purpose — exercises both "wins a task" and "pool exhausted, get null" paths under the same contention.

      const taskIds: number[] = [];
      for (let i = 0; i < TASK_COUNT; i++) {
        const task = await tasksDb.createTask({
          title: `${TAG}_task_${i}`,
          priority: ((i % 4) + 1) as 1 | 2 | 3 | 4, // mix of priorities so ordering is exercised too, not just filtering
          type: "improvement",
          tabIds: [tabId],
        });
        taskIds.push(task.id);
        createdTaskIds.push(task.id);
      }

      // Fire every claim attempt at once. Each call independently reads the
      // candidate list and races to claim one — this is exactly the
      // "N agent sessions poll simultaneously" scenario the whole claim
      // redesign exists to handle.
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_CALLERS }, () =>
          taskClaimer.claimTask(undefined, [tabId], "todo", "in-progress")
        )
      );

      const claimed = results.filter((r): r is NonNullable<typeof r> => r !== null);
      const claimedIds = claimed.map((c) => c.id);
      const uniqueClaimedIds = new Set(claimedIds);

      // The core correctness assertion: no task was ever handed to two
      // different callers. If this ever fails, it means the CAS loop's
      // "state no longer matches claimState -> zero rows -> move to next
      // candidate" logic did not hold under real concurrency.
      expect(uniqueClaimedIds.size).toBe(claimedIds.length);

      // Every task in the pool should have been claimed exactly once —
      // not fewer (which would mean claims were lost/blocked) and not more
      // (which the uniqueness check above already covers, but this checks
      // completeness too: every seeded task actually got claimed by someone).
      expect(claimed.length).toBe(TASK_COUNT);
      expect([...uniqueClaimedIds].sort((a, b) => a - b)).toEqual([...taskIds].sort((a, b) => a - b));

      // Callers beyond the pool size should cleanly get null, not an error
      // and not a duplicate/garbage claim.
      const nullResults = results.filter((r) => r === null);
      expect(nullResults.length).toBe(CONCURRENT_CALLERS - TASK_COUNT);

      // Cross-check directly against the database (not just the in-memory
      // return values): every seeded task should now be 'in-progress',
      // none left in 'todo' and none double-transitioned to some other state.
      for (const id of taskIds) {
        const task = await tasksDb.getTaskById(id);
        expect(task?.state).toBe("in-progress");
      }
    },
    60000
  );

  it(
    "when many callers race for one specific taskId, exactly one wins",
    async () => {
      const task = await tasksDb.createTask({
        title: `${TAG}_specific_task`,
        priority: 1,
        type: "bug",
        tabIds: [tabId],
      });
      createdTaskIds.push(task.id);

      const CONCURRENT_CALLERS = 15;
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_CALLERS }, () =>
          taskClaimer.claimTask(task.id, undefined, "todo", "in-progress")
        )
      );

      const claimed = results.filter((r) => r !== null);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.id).toBe(task.id);

      const nullResults = results.filter((r) => r === null);
      expect(nullResults.length).toBe(CONCURRENT_CALLERS - 1);

      const final = await tasksDb.getTaskById(task.id);
      expect(final?.state).toBe("in-progress");
    },
    30000
  );

  it(
    "claimTask excludes blocked tasks even under concurrent access",
    async () => {
      const blocker = await tasksDb.createTask({
        title: `${TAG}_blocker`,
        priority: 1,
        type: "bug",
        tabIds: [tabId],
      });
      createdTaskIds.push(blocker.id);

      const blocked = await tasksDb.createTask({
        title: `${TAG}_blocked`,
        priority: 1, // highest priority — would win the race if blocking weren't respected
        type: "feature",
        tabIds: [tabId],
        dependsOn: [blocker.id],
      });
      createdTaskIds.push(blocked.id);

      // Many concurrent callers, but only `blocker` is actually claimable —
      // `blocked` must never be returned to any of them, despite outranking
      // `blocker` on priority.
      const results = await Promise.all(
        Array.from({ length: 10 }, () => taskClaimer.claimTask(undefined, [tabId], "todo", "in-progress"))
      );

      const claimed = results.filter((r) => r !== null);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.id).toBe(blocker.id);

      const stillBlocked = await tasksDb.getTaskById(blocked.id);
      expect(stillBlocked?.state).toBe("todo");
    },
    30000
  );
});
