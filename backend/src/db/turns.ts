/**
 * Turn persistence — stores per-turn credit/usage data in Neo4j.
 *
 * Graph model:
 *   (:Session)-[:HAS_TURN]->(:Turn)
 *   (:Turn)-[:IN_TAB]->(:Tab)
 *
 * A Turn node captures a single prompt turn's credit consumption, tied to
 * the session that produced it and (optionally) the tab context.
 */

import { writeQuery, readQuery } from "./connection.js";
import type { ManagedTransaction } from "neo4j-driver";
import { getNextId } from "./id-counter.js";

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
    tabId: number | null;
    credits: number;
    costEur: number;
    turns: number;
    firstTurn: string;
    lastTurn: string;
  }[];
}

const EUR_PER_CREDIT = 0.04;

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
        RETURN t.id AS id, t.sessionId AS sessionId, t.sessionName AS sessionName,
               t.agent AS agent, t.credits AS credits, t.taskId AS taskId,
               toString(t.timestamp) AS timestamp
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
        tabId: null as number | null, // Tabs are per-turn, not per-session aggregate
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
