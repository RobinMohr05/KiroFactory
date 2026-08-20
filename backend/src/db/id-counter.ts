/**
 * Atomic integer ID allocation, replacing SQL Server's IDENTITY(1,1) columns.
 *
 * Neo4j has no native auto-increment. Every entity that previously had an
 * IDENTITY primary key (User, Tab, Task, Agent, Session) instead gets its ID
 * from a dedicated `:Counter {name}` node, one per label. Unlike the
 * concurrency-safe task CLAIM path (agent/task-claimer.ts), which deliberately
 * avoids relying on implicit lock timing, allocating a new ID is *supposed* to
 * serialize — that's the definition of "no two entities get the same ID" — so
 * this leans directly on Neo4j's default write lock on the single Counter
 * node, via a managed write transaction (auto-retried by the driver on
 * transient/deadlock errors).
 *
 * See design.md "Entity IDs" for the full rationale.
 */

import type { ManagedTransaction } from "neo4j-driver";
import { writeQuery } from "./connection.js";

export type CounterLabel = "User" | "Tab" | "Task" | "Agent" | "Session" | "Turn";

/**
 * Allocates and returns the next integer ID for the given label.
 *
 * First call for a fresh label creates the counter at 0 and returns 1 —
 * matching SQL Server's IDENTITY(1,1) starting point.
 */
export async function getNextId(label: CounterLabel): Promise<number> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MERGE (c:Counter {name: $label})
       ON CREATE SET c.value = 0
       SET c.value = c.value + 1
       RETURN c.value AS id`,
      { label }
    );
    return result.records[0].get("id") as number;
  });
}

/**
 * Seeds (or raises) a label's counter to at least `minValue`, without ever
 * lowering it. Used only by the one-time migration script
 * (backend/scripts/migrate-to-neo4j.ts) to continue numbering above the
 * highest ID imported from Azure SQL, per Requirement 4.3 — never called
 * during normal app operation.
 */
export async function ensureCounterAtLeast(label: CounterLabel, minValue: number): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MERGE (c:Counter {name: $label})
       ON CREATE SET c.value = $minValue
       ON MATCH SET c.value = CASE WHEN c.value < $minValue THEN $minValue ELSE c.value END`,
      { label, minValue }
    );
  });
}
