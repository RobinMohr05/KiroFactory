/**
 * Planner Conversations DB — Persists AI Task Planner transcripts in Neo4j.
 *
 * Graph model:
 *   (:User)-[:OWNS]->(:PlannerConversation)-[:HAS_MESSAGE {position}]->(:PlannerMessage)
 *
 * PlannerConversation props:
 *   id (allocated via id-counter, like every other node — see db/id-counter.ts),
 *   userId, tabId (nullable), shortDescription, createdAt, lastMessageAt.
 * PlannerMessage props:
 *   role ("user" | "assistant"), text, position (0-based order), createdAt.
 *
 * A planner conversation is created lazily on the FIRST user message of a live
 * planner session (see routes/task-planner.ts), then grows one PlannerMessage
 * per user/assistant turn. Transcripts survive an unexpected session death and
 * can be replayed into a fresh planner via the resume path. They auto-expire
 * 7 days after creation via an in-process sweeper
 * (initPlannerConversationCleanup, wired in index.ts).
 *
 * IMPORTANT: image blobs are NEVER persisted — sanitizePlannerMessageText()
 * replaces any attached image with the literal marker `[image]` before storage.
 *
 * Cypher conventions mirror db/turns.ts: raw Cypher via managed
 * readQuery/writeQuery transactions, ids from getNextId().
 */

import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import { getNextId } from "./id-counter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlannerMessageRole = "user" | "assistant";

export interface PlannerMessageRecord {
  role: PlannerMessageRole;
  text: string;
  position: number;
  createdAt: string;
}

/** Summary shape returned by listPlannerConversations (no messages). */
export interface PlannerConversationSummary {
  id: number;
  shortDescription: string;
  createdAt: string;
  lastMessageAt: string;
  taskCreated: boolean;
}

/** Full transcript shape returned by getPlannerConversation. */
export interface PlannerConversationRecord extends PlannerConversationSummary {
  messages: PlannerMessageRecord[];
}

export interface CreatePlannerConversationInput {
  userId: number;
  tabId?: number | null;
  /** The first user message — used to derive shortDescription. */
  firstUserMessage: string;
}

export interface AppendPlannerMessageInput {
  conversationId: number;
  role: PlannerMessageRole;
  text: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

const SHORT_DESCRIPTION_MAX = 60;
const FALLBACK_SHORT_DESCRIPTION = "Untitled planning session";

/**
 * Derive a conversation's shortDescription from its first user message:
 * trimmed, truncated to 60 chars (with a trailing "…" when truncated), or the
 * fallback label when empty.
 */
export function derivePlannerShortDescription(firstUserMessage: string): string {
  const trimmed = (firstUserMessage ?? "").trim();
  if (trimmed.length === 0) return FALLBACK_SHORT_DESCRIPTION;
  if (trimmed.length <= SHORT_DESCRIPTION_MAX) return trimmed;
  return trimmed.slice(0, SHORT_DESCRIPTION_MAX) + "…";
}

/**
 * Produce the text to persist for a planner message. Image blobs are never
 * stored — each attached image is replaced by the literal marker `[image]`,
 * appended after the (trimmed) message text.
 */
export function sanitizePlannerMessageText(
  text: string,
  images?: { data: string; mimeType: string }[]
): string {
  const base = (text ?? "").trim();
  if (!images || images.length === 0) return base;
  const markers = images.map(() => "[image]").join(" ");
  return base.length > 0 ? `${base} ${markers}` : markers;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a PlannerConversation node owned by the given user. `createdAt` and
 * `lastMessageAt` are both set to "now". Returns the created summary.
 *
 * The owner MATCH is strict (non-OPTIONAL) — if no User with that id exists the
 * CREATE never runs and zero rows come back (mirrors insertSession's contract).
 */
export async function createPlannerConversation(
  input: CreatePlannerConversationInput
): Promise<PlannerConversationSummary> {
  const id = await getNextId("PlannerConversation");
  const shortDescription = derivePlannerShortDescription(input.firstUserMessage);
  const nowIso = new Date().toISOString();

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})
       CREATE (u)-[:OWNS]->(c:PlannerConversation {
         id: $id,
         userId: $userId,
         tabId: $tabId,
         shortDescription: $shortDescription,
         createdAt: datetime($now),
         lastMessageAt: datetime($now)
       })
       RETURN c.id AS id, c.shortDescription AS shortDescription,
              toString(c.createdAt) AS createdAt, toString(c.lastMessageAt) AS lastMessageAt,
              coalesce(c.taskCreated, false) AS taskCreated`,
      {
        id,
        userId: input.userId,
        tabId: input.tabId ?? null,
        shortDescription,
        now: nowIso,
      }
    );

    if (result.records.length === 0) {
      throw new Error(
        `createPlannerConversation: no User found with id ${input.userId} — cannot create an owned conversation`
      );
    }

    const record = result.records[0];
    return {
      id: record.get("id") as number,
      shortDescription: record.get("shortDescription") as string,
      createdAt: record.get("createdAt") as string,
      lastMessageAt: record.get("lastMessageAt") as string,
      taskCreated: record.get("taskCreated") as boolean,
    };
  });
}

/**
 * Append a PlannerMessage to a conversation at the next 0-based position and
 * bump the conversation's lastMessageAt. The position is computed as the
 * current message count so ordering is deterministic. Returns the appended
 * message's position (or null if the conversation doesn't exist).
 */
export async function appendPlannerMessage(
  input: AppendPlannerMessageInput
): Promise<number | null> {
  const nowIso = new Date().toISOString();

  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (c:PlannerConversation {id: $conversationId})
       WITH c
       OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(existing:PlannerMessage)
       WITH c, count(existing) AS position
       CREATE (c)-[:HAS_MESSAGE {position: position}]->(m:PlannerMessage {
         role: $role,
         text: $text,
         position: position,
         createdAt: datetime($now)
       })
       SET c.lastMessageAt = datetime($now)
       RETURN m.position AS position`,
      {
        conversationId: input.conversationId,
        role: input.role,
        text: input.text,
        now: nowIso,
      }
    );

    if (result.records.length === 0) return null;
    return result.records[0].get("position") as number;
  });
}

/**
 * List a user's planner conversations, newest first (by lastMessageAt).
 * Returns summaries only (no message transcripts).
 */
export async function listPlannerConversations(
  userId: number
): Promise<PlannerConversationSummary[]> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(c:PlannerConversation)
       RETURN c.id AS id, c.shortDescription AS shortDescription,
              toString(c.createdAt) AS createdAt, toString(c.lastMessageAt) AS lastMessageAt,
              coalesce(c.taskCreated, false) AS taskCreated
       ORDER BY c.lastMessageAt DESC`,
      { userId }
    );

    return result.records.map((record) => ({
      id: record.get("id") as number,
      shortDescription: record.get("shortDescription") as string,
      createdAt: record.get("createdAt") as string,
      lastMessageAt: record.get("lastMessageAt") as string,
      taskCreated: record.get("taskCreated") as boolean,
    }));
  });
}

/**
 * Get the full ordered transcript for a conversation, enforcing ownership:
 * only returns it when the (:User {userId})-[:OWNS]->(:PlannerConversation)
 * edge exists. Returns null if not found or not owned.
 */
export async function getPlannerConversation(
  id: number,
  userId: number
): Promise<PlannerConversationRecord | null> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(c:PlannerConversation {id: $id})
       CALL (c) {
         OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:PlannerMessage)
         WITH m ORDER BY m.position ASC
         WITH collect(CASE WHEN m IS NOT NULL THEN {
           role: m.role, text: m.text, position: m.position,
           createdAt: toString(m.createdAt)
         } END) AS raw
         RETURN [x IN raw WHERE x IS NOT NULL] AS messages
       }
       RETURN c.id AS id, c.shortDescription AS shortDescription,
              toString(c.createdAt) AS createdAt, toString(c.lastMessageAt) AS lastMessageAt,
              coalesce(c.taskCreated, false) AS taskCreated,
              messages`,
      { id, userId }
    );

    if (result.records.length === 0) return null;

    const record = result.records[0];
    const messages = (record.get("messages") as PlannerMessageRecord[]) ?? [];
    return {
      id: record.get("id") as number,
      shortDescription: record.get("shortDescription") as string,
      createdAt: record.get("createdAt") as string,
      lastMessageAt: record.get("lastMessageAt") as string,
      taskCreated: record.get("taskCreated") as boolean,
      messages: messages.map((m) => ({
        role: m.role,
        text: m.text,
        position: m.position,
        createdAt: m.createdAt,
      })),
    };
  });
}

/**
 * Delete a conversation (and its messages) — only when owned by the user.
 * Returns true if a conversation was deleted, false otherwise.
 */
export async function deletePlannerConversation(
  id: number,
  userId: number
): Promise<boolean> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (u:User {id: $userId})-[:OWNS]->(c:PlannerConversation {id: $id})
       OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:PlannerMessage)
       WITH c, collect(m) AS messages, count(DISTINCT c) AS deletedCount
       DETACH DELETE c
       FOREACH (msg IN messages | DETACH DELETE msg)
       RETURN deletedCount`,
      { id, userId }
    );

    return (result.records[0]?.get("deletedCount") as number) > 0;
  });
}

/**
 * Mark a planner conversation as having produced at least one task.
 * Sets `taskCreated = true` and `taskCreatedAt = datetime()` on the node.
 * Idempotent — safe to call multiple times. No-op if the conversation does
 * not exist (MATCH-and-SET; zero rows matched is fine).
 */
export async function markPlannerConversationTaskCreated(
  conversationId: number
): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MATCH (c:PlannerConversation {id: $conversationId})
       SET c.taskCreated = true, c.taskCreatedAt = datetime()`,
      { conversationId }
    );
  });
}

/**
 * Delete all conversations whose createdAt is strictly older than the given
 * ISO cutoff, DETACH DELETEing each conversation and its messages. Returns the
 * number of conversations deleted. Used by the 7-day TTL sweeper.
 */
export async function deleteExpiredPlannerConversations(
  olderThanIso: string
): Promise<number> {
  return writeQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      `MATCH (c:PlannerConversation)
       WHERE c.createdAt < datetime($cutoff)
       OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:PlannerMessage)
       WITH c, collect(m) AS messages, count(DISTINCT c) AS deletedCount
       DETACH DELETE c
       FOREACH (msg IN messages | DETACH DELETE msg)
       RETURN sum(deletedCount) AS deletedCount`,
      { cutoff: olderThanIso }
    );

    return (result.records[0]?.get("deletedCount") as number) ?? 0;
  });
}
