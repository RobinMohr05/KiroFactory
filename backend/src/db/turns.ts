/**
 * Turns DB — Persists turn-level data in Neo4j.
 *
 * Graph model:
 *   (:Session)-[:HAS_TURN]->(:Turn)
 *   (:Session)-[:HAS_ERROR]->(:ErrorEvent)
 *
 * Turn nodes track per-prompt-turn metrics (credits, cost, verdict, duration,
 * tool calls) for historical review and the credits dashboard. They are created
 * at turn-start and updated at turn-end.
 *
 * ErrorEvent nodes persist session errors for historical review, complementing
 * the in-memory error-store used for the live Errors tab.
 */

import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnRecord {
  number: number;
  startedAt: string;
  endedAt: string | null;
  credits: number;
  costEur: number;
  verdict: string | null;
  taskId: number | null;
  taskTitle: string | null;
  toolCallCount: number;
  hasChanges: boolean;
  prUrl: string | null;
  branchName: string | null;
  durationMs: number;
  sessionId: number;
}

export interface CreateTurnInput {
  sessionId: number;
  number: number;
  startedAt: string;
  taskId?: number | null;
  taskTitle?: string | null;
}

export interface CompleteTurnInput {
  sessionId: number;
  number: number;
  endedAt: string;
  credits: number;
  costEur: number;
  verdict?: string | null;
  durationMs: number;
  toolCallCount: number;
  hasChanges: boolean;
  prUrl?: string | null;
  branchName?: string | null;
}

export interface ErrorEventRecord {
  id: string;
  timestamp: string;
  message: string;
  taskId: number | null;
  taskTitle: string | null;
  sessionId: number;
}

export interface CreateErrorEventInput {
  sessionId: number;
  timestamp: string;
  message: string;
  taskId?: number | null;
  taskTitle?: string | null;
}

export interface UsageAggregation {
  sessionId: number;
  sessionName: string;
  date: string;
  totalCredits: number;
  totalCostEur: number;
  turnCount: number;
}

// ---------------------------------------------------------------------------
// Turn CRUD
// ---------------------------------------------------------------------------

/**
 * Create a Turn node at turn-start, linked to the session via [:HAS_TURN].
 * Uses MERGE to handle session restarts gracefully — if a Turn with the same
 * sessionId + number already exists (from a previous run), it is reused rather
 * than creating a duplicate.
 */
export async function createTurn(input: CreateTurnInput): Promise<TurnRecord> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})
       MERGE (s)-[:HAS_TURN]->(t:Turn {sessionId: $sessionId, number: $number})
       ON CREATE SET
         t.startedAt = $startedAt,
         t.endedAt = null,
         t.credits = 0,
         t.costEur = 0,
         t.verdict = null,
         t.taskId = $taskId,
         t.taskTitle = $taskTitle,
         t.toolCallCount = 0,
         t.hasChanges = false,
         t.prUrl = null,
         t.branchName = null,
         t.durationMs = 0
       ON MATCH SET
         t.startedAt = $startedAt,
         t.endedAt = null,
         t.credits = 0,
         t.costEur = 0,
         t.verdict = null,
         t.taskId = $taskId,
         t.taskTitle = $taskTitle,
         t.toolCallCount = 0,
         t.hasChanges = false,
         t.prUrl = null,
         t.branchName = null,
         t.durationMs = 0
       RETURN t.number AS number, t.startedAt AS startedAt, s.id AS sessionId`,
      {
        sessionId: input.sessionId,
        number: input.number,
        startedAt: input.startedAt,
        taskId: input.taskId ?? null,
        taskTitle: input.taskTitle ?? null,
      }
    );

    const record = result.records[0];
    return {
      number: record.get("number"),
      startedAt: record.get("startedAt"),
      endedAt: null,
      credits: 0,
      costEur: 0,
      verdict: null,
      taskId: input.taskId ?? null,
      taskTitle: input.taskTitle ?? null,
      toolCallCount: 0,
      hasChanges: false,
      prUrl: null,
      branchName: null,
      durationMs: 0,
      sessionId: record.get("sessionId"),
    };
  });
}

/**
 * Update a Turn node at turn-end with the final summary data.
 */
export async function completeTurn(input: CompleteTurnInput): Promise<TurnRecord | null> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})-[:HAS_TURN]->(t:Turn {number: $number})
       SET t.endedAt = $endedAt,
           t.credits = $credits,
           t.costEur = $costEur,
           t.verdict = $verdict,
           t.durationMs = $durationMs,
           t.toolCallCount = $toolCallCount,
           t.hasChanges = $hasChanges,
           t.prUrl = $prUrl,
           t.branchName = $branchName
       RETURN t.number AS number, t.startedAt AS startedAt, t.endedAt AS endedAt,
              t.credits AS credits, t.costEur AS costEur, t.verdict AS verdict,
              t.durationMs AS durationMs, t.toolCallCount AS toolCallCount,
              t.hasChanges AS hasChanges, t.prUrl AS prUrl, t.branchName AS branchName,
              t.taskId AS taskId, t.taskTitle AS taskTitle, s.id AS sessionId`,
      {
        sessionId: input.sessionId,
        number: input.number,
        endedAt: input.endedAt,
        credits: input.credits,
        costEur: input.costEur,
        verdict: input.verdict ?? null,
        durationMs: input.durationMs,
        toolCallCount: input.toolCallCount,
        hasChanges: input.hasChanges,
        prUrl: input.prUrl ?? null,
        branchName: input.branchName ?? null,
      }
    );

    if (result.records.length === 0) return null;

    const record = result.records[0];
    return {
      number: record.get("number"),
      startedAt: record.get("startedAt"),
      endedAt: record.get("endedAt"),
      credits: record.get("credits"),
      costEur: record.get("costEur"),
      verdict: record.get("verdict"),
      taskId: record.get("taskId"),
      taskTitle: record.get("taskTitle"),
      toolCallCount: record.get("toolCallCount"),
      hasChanges: record.get("hasChanges"),
      prUrl: record.get("prUrl"),
      branchName: record.get("branchName"),
      durationMs: record.get("durationMs"),
      sessionId: record.get("sessionId"),
    };
  });
}

/**
 * Get the highest turn number for a session (0 if no turns exist).
 * Used on session restart to continue numbering without collisions.
 */
export async function getMaxTurnNumber(sessionId: number): Promise<number> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})-[:HAS_TURN]->(t:Turn)
       RETURN max(t.number) AS maxNumber`,
      { sessionId }
    );
    const record = result.records[0];
    const maxNumber = record?.get("maxNumber");
    return typeof maxNumber === "number" ? maxNumber : 0;
  });
}

/**
 * Get all turns for a session, ordered by turn number ascending.
 */
export async function getTurnsBySession(sessionId: number): Promise<TurnRecord[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})-[:HAS_TURN]->(t:Turn)
       RETURN t.number AS number, t.startedAt AS startedAt, t.endedAt AS endedAt,
              t.credits AS credits, t.costEur AS costEur, t.verdict AS verdict,
              t.durationMs AS durationMs, t.toolCallCount AS toolCallCount,
              t.hasChanges AS hasChanges, t.prUrl AS prUrl, t.branchName AS branchName,
              t.taskId AS taskId, t.taskTitle AS taskTitle, s.id AS sessionId
       ORDER BY t.number ASC`,
      { sessionId }
    );

    return result.records.map((record) => ({
      number: record.get("number"),
      startedAt: record.get("startedAt"),
      endedAt: record.get("endedAt"),
      credits: record.get("credits") ?? 0,
      costEur: record.get("costEur") ?? 0,
      verdict: record.get("verdict"),
      taskId: record.get("taskId"),
      taskTitle: record.get("taskTitle"),
      toolCallCount: record.get("toolCallCount") ?? 0,
      hasChanges: record.get("hasChanges") ?? false,
      prUrl: record.get("prUrl"),
      branchName: record.get("branchName"),
      durationMs: record.get("durationMs") ?? 0,
      sessionId: record.get("sessionId"),
    }));
  });
}

/**
 * Get aggregated usage data for a user within a date range,
 * optionally filtered by tab.
 * Returns per-session, per-day breakdowns.
 */
export async function getTurnsByUserAndPeriod(
  userId: number,
  from: string,
  to: string,
  tabId?: number
): Promise<UsageAggregation[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    // Build the query with optional tab filter
    const tabFilter = tabId != null
      ? `AND (s)-[:IN_TAB]->(:Tab {id: $tabId})`
      : "";

    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(s:Session)-[:HAS_TURN]->(t:Turn)
       WHERE t.endedAt IS NOT NULL
         AND t.startedAt >= $from
         AND t.startedAt <= $to
         ${tabFilter}
       WITH s, t, substring(t.startedAt, 0, 10) AS date
       RETURN s.id AS sessionId, s.name AS sessionName, date,
              sum(t.credits) AS totalCredits,
              sum(t.costEur) AS totalCostEur,
              count(t) AS turnCount
       ORDER BY date ASC, s.name ASC`,
      {
        userId,
        from,
        to,
        ...(tabId != null ? { tabId } : {}),
      }
    );

    return result.records.map((record) => ({
      sessionId: record.get("sessionId"),
      sessionName: record.get("sessionName"),
      date: record.get("date"),
      totalCredits: record.get("totalCredits") ?? 0,
      totalCostEur: record.get("totalCostEur") ?? 0,
      turnCount: record.get("turnCount") ?? 0,
    }));
  });
}

// ---------------------------------------------------------------------------
// Error Events
// ---------------------------------------------------------------------------

/**
 * Create an ErrorEvent node linked to a Session via [:HAS_ERROR].
 */
export async function createErrorEvent(input: CreateErrorEventInput): Promise<ErrorEventRecord> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const id = `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})
       CREATE (s)-[:HAS_ERROR]->(e:ErrorEvent {
         id: $id,
         timestamp: $timestamp,
         message: $message,
         taskId: $taskId,
         taskTitle: $taskTitle
       })
       RETURN e.id AS id, e.timestamp AS timestamp, e.message AS message,
              e.taskId AS taskId, e.taskTitle AS taskTitle, s.id AS sessionId`,
      {
        sessionId: input.sessionId,
        id,
        timestamp: input.timestamp,
        message: input.message,
        taskId: input.taskId ?? null,
        taskTitle: input.taskTitle ?? null,
      }
    );

    const record = result.records[0];
    return {
      id: record.get("id"),
      timestamp: record.get("timestamp"),
      message: record.get("message"),
      taskId: record.get("taskId"),
      taskTitle: record.get("taskTitle"),
      sessionId: record.get("sessionId"),
    };
  });
}

/**
 * Get all error events for a session, ordered by timestamp ascending.
 */
export async function getErrorsBySession(sessionId: number): Promise<ErrorEventRecord[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (s:Session {id: $sessionId})-[:HAS_ERROR]->(e:ErrorEvent)
       RETURN e.id AS id, e.timestamp AS timestamp, e.message AS message,
              e.taskId AS taskId, e.taskTitle AS taskTitle, s.id AS sessionId
       ORDER BY e.timestamp ASC`,
      { sessionId }
    );

    return result.records.map((record) => ({
      id: record.get("id"),
      timestamp: record.get("timestamp"),
      message: record.get("message"),
      taskId: record.get("taskId"),
      taskTitle: record.get("taskTitle"),
      sessionId: record.get("sessionId"),
    }));
  });
}
