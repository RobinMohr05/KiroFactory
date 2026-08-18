/**
 * Cycle-detection and isBlocked/blockedBy correctness tests for the task
 * dependency feature (Requirements 2.4, 2.5 — see
 * .kiro/specs/neo4j-migration/design.md, "Task dependencies" section, and
 * db/tasks.ts's replaceDependencies() for the implementation under test).
 *
 * Same "real AuraDB, not mocked" rationale as the sibling
 * task-claim-concurrency.test.ts: the thing under test is Cypher
 * path-reachability logic actually running against the real graph engine.
 * A mocked driver would only assert "did we call tx.run with X" — it can't
 * tell us whether Neo4j's own traversal genuinely rejects a cycle, which is
 * the entire point of testing this at all. This file follows that sibling
 * file's conventions: skip the whole suite if NEO4J_URI isn't configured,
 * tag every fixture with a run-unique prefix, and clean up everything
 * created in afterAll — this test creates and destroys real data on the
 * shared instance, never touching any pre-existing tasks/tabs/users.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import { DependencyCycleError } from "../types.js";

// See task-claim-concurrency.test.ts's identical comment: describe.skipIf's
// condition is evaluated synchronously at collection time, so NEO4J_URI must
// already be in process.env by the time this file's top level finishes
// executing — dotenv.config() is called directly here rather than deferred
// into beforeAll, for the same reason that file defers it: connection.ts
// only calls dotenv.config() once it's actually imported, and deferring the
// import into beforeAll (to avoid loading the db layer when skipped) would
// make this check always see an empty env and skip unconditionally even
// with real credentials configured.
dotenv.config();

const hasNeo4jConfigured = !!process.env.NEO4J_URI;

describe.skipIf(!hasNeo4jConfigured)(
  "Task dependencies — cycle detection and isBlocked/blockedBy (live AuraDB integration test)",
  () => {
    let connection: typeof import("../db/connection.js");
    let usersDb: typeof import("../db/users.js");
    let tabsDb: typeof import("../db/tabs.js");
    let tasksDb: typeof import("../db/tasks.js");

    const TAG = `dep-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let userId = -1;
    let tabId = -1;
    const createdTaskIds: number[] = [];

    beforeAll(async () => {
      connection = await import("../db/connection.js");
      usersDb = await import("../db/users.js");
      tabsDb = await import("../db/tabs.js");
      tasksDb = await import("../db/tasks.js");

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
    }, 60000);

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
    }, 60000);

    /** Creates a tagged, auto-cleaned-up task, optionally with initial dependencies. */
    async function makeTask(title: string, dependsOn?: number[]) {
      const task = await tasksDb.createTask({
        title: `${TAG}_${title}`,
        priority: 2,
        type: "improvement",
        tabIds: [tabId],
        dependsOn,
      });
      createdTaskIds.push(task.id);
      return task;
    }

    // -------------------------------------------------------------------
    // Cycle detection (Requirement 2.4)
    // -------------------------------------------------------------------

    it("rejects a direct two-task cycle (A depends on B, then B depends on A)", async () => {
      const a = await makeTask("direct_a");
      const b = await makeTask("direct_b");

      const updated = await tasksDb.updateTask(a.id, { dependsOn: [b.id] });
      expect(updated?.dependsOn).toEqual([b.id]);

      let caught: unknown;
      try {
        await tasksDb.updateTask(b.id, { dependsOn: [a.id] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DependencyCycleError);
      expect((caught as DependencyCycleError).fromId).toBe(b.id);
      expect((caught as DependencyCycleError).toId).toBe(a.id);

      // The rejected write must not have partially applied — b's own
      // dependsOn (never successfully set) should still be empty.
      const bAfter = await tasksDb.getTaskById(b.id);
      expect(bAfter?.dependsOn).toEqual([]);
    });

    it("rejects a transitive three-task cycle (A depends on B, B depends on C, then C depends on A)", async () => {
      const a = await makeTask("trans_a");
      const b = await makeTask("trans_b");
      const c = await makeTask("trans_c");

      await tasksDb.updateTask(a.id, { dependsOn: [b.id] });
      await tasksDb.updateTask(b.id, { dependsOn: [c.id] });

      let caught: unknown;
      try {
        await tasksDb.updateTask(c.id, { dependsOn: [a.id] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DependencyCycleError);
      expect((caught as DependencyCycleError).fromId).toBe(c.id);
      expect((caught as DependencyCycleError).toId).toBe(a.id);

      const cAfter = await tasksDb.getTaskById(c.id);
      expect(cAfter?.dependsOn).toEqual([]);
    });

    it("rejects a task depending on itself", async () => {
      const f = await makeTask("self");

      let caught: unknown;
      try {
        await tasksDb.updateTask(f.id, { dependsOn: [f.id] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DependencyCycleError);
      expect((caught as DependencyCycleError).fromId).toBe(f.id);
      expect((caught as DependencyCycleError).toId).toBe(f.id);

      const fAfter = await tasksDb.getTaskById(f.id);
      expect(fAfter?.dependsOn).toEqual([]);
    });

    it("accepts a non-cyclic multi-dependency (one task depending on two unrelated tasks)", async () => {
      const g = await makeTask("multi_g");
      const h = await makeTask("multi_h");
      const i = await makeTask("multi_i");

      const updated = await tasksDb.updateTask(g.id, { dependsOn: [h.id, i.id] });
      expect(updated?.dependsOn?.slice().sort((x, y) => x - y)).toEqual([h.id, i.id].sort((x, y) => x - y));

      const fetched = await tasksDb.getTaskById(g.id);
      expect(fetched?.dependsOn?.slice().sort((x, y) => x - y)).toEqual([h.id, i.id].sort((x, y) => x - y));
    });

    // -------------------------------------------------------------------
    // isBlocked / blockedBy correctness (Requirement 2.5)
    // -------------------------------------------------------------------

    it("a task with no dependencies is not blocked", async () => {
      const task = await makeTask("unblocked_none");

      const fetched = await tasksDb.getTaskById(task.id);
      expect(fetched?.isBlocked).toBe(false);
      expect(fetched?.blockedBy).toEqual([]);
    });

    it("a task is not blocked once every dependency is done", async () => {
      const blocker = await makeTask("done_blocker");
      await tasksDb.updateTask(blocker.id, { state: "done" });

      const dependent = await makeTask("done_dependent", [blocker.id]);

      const fetched = await tasksDb.getTaskById(dependent.id);
      expect(fetched?.isBlocked).toBe(false);
      expect(fetched?.blockedBy).toEqual([]);
    });

    it("a task is blocked while a dependency is not done, and names the blocker", async () => {
      const blocker = await makeTask("incomplete_blocker");
      const dependent = await makeTask("incomplete_dependent", [blocker.id]);

      const fetched = await tasksDb.getTaskById(dependent.id);
      expect(fetched?.isBlocked).toBe(true);
      expect(fetched?.blockedBy).toEqual([{ id: blocker.id, title: blocker.title }]);
    });

    it("a task with one done and one incomplete dependency is still blocked, naming only the incomplete one", async () => {
      const doneBlocker = await makeTask("mixed_done_blocker");
      await tasksDb.updateTask(doneBlocker.id, { state: "done" });
      const incompleteBlocker = await makeTask("mixed_incomplete_blocker");

      const dependent = await makeTask("mixed_dependent", [doneBlocker.id, incompleteBlocker.id]);

      const fetched = await tasksDb.getTaskById(dependent.id);
      expect(fetched?.isBlocked).toBe(true);
      expect(fetched?.blockedBy).toEqual([{ id: incompleteBlocker.id, title: incompleteBlocker.title }]);
    });
  }
);
