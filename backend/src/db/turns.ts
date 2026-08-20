/**
 * Turns DB — Persists turn-level data in Neo4j.
 *
 * Graph model:
 *   (:Session)-[:HAS_TURN]->(:Turn)
 *   (:Session)-[:HAS_ERROR]->(:ErrorEvent)
 *   (:Turn)-[:IN_TAB]->(:Tab)
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
import { getNextId } from "./id-counter.js";

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

/** Simple turn shape used by the recordTurn/getUsage flow. */
export interface Turn {
  id: number;
  sessionId: number;
  sessionName: string;
  agent: string;
  credits: number;
  taskId: number | null;
  timestamp: string;
  tabIds: number[];
}

export interface UsageSummary {
  totalCredits: number;
  totalCostEur: number;
  dailyBreakdown: { date: string; credits: number; costEur: number }[];
  sessionBreakdown: {
    sessionId: number;
    sessionName: string;
    agent: string;
    tabName: string | null;
    credits: number;
    costEur: number;
    turns: number;
    firstTurn: string;
    lastTurn: string;
  }[];
}

const EUR_PER_CREDIT = 0.04;

// ---------------------------------------------------------------------------
// Turn CRUD (detailed turn tracking for the timeline view)
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
      ? "AND (s)-[:IN_TAB]->(:Tab {id: $tabId})"
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
// Simple turn recording (used by the usage dashboard)
// ---------------------------------------------------------------------------

/**
 * Record a turn with credit consumption.
 */
export async function recordTurn(params: {
  sessionId: number;
  sessionName: string;
  agent: string;
  credits: number;
  taskId: number | null;
  tabIds: number[];
}): Promise<Turn> {
  const id = await getNextId("Turn");
  const timestamp = new Date().toISOString();

  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `
        MATCH (s:Session {id: $sessionId})
        CREATE (t:Turn {
          id: $id,
          sessionId: $sessionId,
          sessionName: $sessionName,
          agent: $agent,
          credits: $credits,
          taskId: $taskId,
          timestamp: datetime($timestamp)
        })
        CREATE (s)-[:HAS_TURN]->(t)
        WITH t
        CALL (t) {
          UNWIND $tabIds AS tabId
          MATCH (tab:Tab {id: tabId})
          CREATE (t)-[:IN_TAB]->(tab)
        }
      `,
      {
        id,
        sessionId: params.sessionId,
        sessionName: params.sessionName,
        agent: params.agent,
        credits: params.credits,
        taskId: params.taskId ?? null,
        timestamp,
        tabIds: params.tabIds,
      }
    );
  });

  return {
    id,
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    agent: params.agent,
    credits: params.credits,
    taskId: params.taskId,
    timestamp,
    tabIds: params.tabIds,
  };
}

/**
 * Query usage data for a date range, optionally filtered by tab.
 */
export async function getUsage(params: {
  from: string;
  to: string;
  tabId?: number | null;
  userId: number;
}): Promise<UsageSummary> {
  return readQuery(async (tx: ManagedTransaction) => {
    const tabFilter = params.tabId
      ? "AND (t)-[:IN_TAB]->(:Tab {id: $tabId})"
      : "";

    // Get all turns in the date range for this user's sessions
    const result = await tx.run(
      `
        MATCH (u:User {id: $userId})-[:OWNS]->(s:Session)-[:HAS_TURN]->(t:Turn)
        WHERE t.timestamp >= datetime($from) AND t.timestamp <= datetime($to)
        ${tabFilter}
        OPTIONAL MATCH (s)-[:IN_TAB]->(tab:Tab)
        WITH t, s, collect(tab.name) AS tabNames
        RETURN t.id AS id, t.sessionId AS sessionId, t.sessionName AS sessionName,
               t.agent AS agent, t.credits AS credits, t.taskId AS taskId,
               toString(t.timestamp) AS timestamp,
               CASE WHEN size(tabNames) > 0 THEN tabNames[0] ELSE null END AS tabName
        ORDER BY t.timestamp ASC
      `,
      {
        userId: params.userId,
        from: params.from,
        to: params.to,
        tabId: params.tabId ?? null,
      }
    );

    const turns = result.records.map((r) => ({
      id: r.get("id") as number,
      sessionId: r.get("sessionId") as number,
      sessionName: r.get("sessionName") as string,
      agent: r.get("agent") as string,
      credits: r.get("credits") as number,
      taskId: r.get("taskId") as number | null,
      timestamp: r.get("timestamp") as string,
      tabName: (r.get("tabName") as string | null) ?? null,
    }));

    // Compute totals
    const totalCredits = turns.reduce((sum, t) => sum + t.credits, 0);
    const totalCostEur = totalCredits * EUR_PER_CREDIT;

    // Daily breakdown
    const dailyMap = new Map<string, number>();
    for (const turn of turns) {
      const date = turn.timestamp.substring(0, 10); // YYYY-MM-DD
      dailyMap.set(date, (dailyMap.get(date) ?? 0) + turn.credits);
    }
    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, credits]) => ({
        date,
        credits,
        costEur: credits * EUR_PER_CREDIT,
      }));

    // Session breakdown
    const sessionMap = new Map<
      number,
      {
        sessionId: number;
        sessionName: string;
        agent: string;
        tabName: string | null;
        credits: number;
        turns: number;
        firstTurn: string;
        lastTurn: string;
      }
    >();
    for (const turn of turns) {
      const existing = sessionMap.get(turn.sessionId);
      if (existing) {
        existing.credits += turn.credits;
        existing.turns += 1;
        if (turn.timestamp < existing.firstTurn) existing.firstTurn = turn.timestamp;
        if (turn.timestamp > existing.lastTurn) existing.lastTurn = turn.timestamp;
      } else {
        sessionMap.set(turn.sessionId, {
          sessionId: turn.sessionId,
          sessionName: turn.sessionName,
          agent: turn.agent,
          tabName: turn.tabName,
          credits: turn.credits,
          turns: 1,
          firstTurn: turn.timestamp,
          lastTurn: turn.timestamp,
        });
      }
    }
    const sessionBreakdown = Array.from(sessionMap.values())
      .sort((a, b) => b.credits - a.credits)
      .map((s) => ({
        ...s,
        costEur: s.credits * EUR_PER_CREDIT,
      }));

    return { totalCredits, totalCostEur, dailyBreakdown, sessionBreakdown };
  });
}

/**
 * Get the current month's total credits for a user (for the header badge).
 */
export async function getCurrentMonthCredits(userId: number): Promise<number> {
  return readQuery(async (tx: ManagedTransaction) => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

    const result = await tx.run(
      `
        MATCH (u:User {id: $userId})-[:OWNS]->(s:Session)-[:HAS_TURN]->(t:Turn)
        WHERE t.timestamp >= datetime($from) AND t.timestamp <= datetime($to)
        RETURN coalesce(sum(t.credits), 0) AS total
      `,
      { userId, from, to }
    );

    return (result.records[0]?.get("total") as number) ?? 0;
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
