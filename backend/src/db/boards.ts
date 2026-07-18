import { getPool, sql } from "./connection.js";
import type { Board, CreateBoardInput, Task, Session } from "../types.js";
import { getAllSessions } from "../session-manager.js";

/**
 * Map a raw DB row to a Board object.
 */
function mapRowToBoard(row: Record<string, unknown>): Board {
  return {
    id: row.id as number,
    name: row.name as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/**
 * Map a raw DB row to a Task object (used when populating board tasks).
 */
function mapRowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    title: row.title as string,
    priority: row.priority as 1 | 2 | 3 | 4,
    type: row.type as Task["type"],
    state: row.state as Task["state"],
    description: row.description as string,
    files: JSON.parse((row.files as string) || "[]"),
    origin: row.origin as Task["origin"],
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getAllBoards(): Promise<Board[]> {
  const pool = await getPool();
  const result = await pool.request().query("SELECT * FROM boards ORDER BY name ASC");
  return result.recordset.map(mapRowToBoard);
}

export async function getBoardById(id: number): Promise<Board | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM boards WHERE id = @id");

  if (result.recordset.length === 0) return null;
  return mapRowToBoard(result.recordset[0]);
}

/**
 * Get a board with all its related entities: tasks, sessions, and agents.
 * Boards are generic containers that organize tasks, sessions, and agents.
 */
export async function getBoardWithTasks(id: number): Promise<Board | null> {
  const pool = await getPool();

  const boardResult = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM boards WHERE id = @id");

  if (boardResult.recordset.length === 0) return null;

  const board = mapRowToBoard(boardResult.recordset[0]);

  // Populate tasks via task_boards junction
  const tasksResult = await pool
    .request()
    .input("boardId", sql.Int, id)
    .query(`
      SELECT t.*
      FROM tasks t
      INNER JOIN task_boards tb ON tb.task_id = t.id
      WHERE tb.board_id = @boardId
      ORDER BY t.priority ASC, t.created_at DESC
    `);

  board.tasks = tasksResult.recordset.map(mapRowToTask);

  // Populate sessions — sessions store boardIds in memory/JSON, so filter from session-manager
  const allSessions = getAllSessions();
  board.sessions = allSessions
    .filter((s) => s.boardIds?.includes(id))
    .map((s) => ({ id: s.id, name: s.name, agent: s.agent, status: s.status }));

  // Populate agents via agent_boards junction
  const agentsResult = await pool
    .request()
    .input("boardId2", sql.Int, id)
    .query(`
      SELECT agent_name
      FROM agent_boards
      WHERE board_id = @boardId2
      ORDER BY agent_name ASC
    `);

  board.agents = agentsResult.recordset.map((row) => row.agent_name as string);

  return board;
}

export async function createBoard(input: CreateBoardInput): Promise<Board> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("name", sql.NVarChar(100), input.name)
    .query(`
      INSERT INTO boards (name)
      OUTPUT INSERTED.*
      VALUES (@name)
    `);

  return mapRowToBoard(result.recordset[0]);
}

export async function updateBoard(id: number, name: string): Promise<Board | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .input("name", sql.NVarChar(100), name)
    .query(`
      UPDATE boards
      SET name = @name
      OUTPUT INSERTED.*
      WHERE id = @id
    `);

  if (result.recordset.length === 0) return null;
  return mapRowToBoard(result.recordset[0]);
}

export async function deleteBoard(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM boards WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Agent ↔ Board management
// ---------------------------------------------------------------------------

/**
 * Get all board IDs an agent belongs to.
 */
export async function getAgentBoards(agentName: string): Promise<number[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agentName", sql.NVarChar(100), agentName)
    .query("SELECT board_id FROM agent_boards WHERE agent_name = @agentName");
  return result.recordset.map((row) => row.board_id as number);
}

/**
 * Assign an agent to one or more boards (idempotent — duplicates are ignored).
 */
export async function assignAgentToBoards(
  agentName: string,
  boardIds: number[]
): Promise<void> {
  const pool = await getPool();
  for (const boardId of boardIds) {
    await pool
      .request()
      .input("agentName", sql.NVarChar(100), agentName)
      .input("boardId", sql.Int, boardId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM agent_boards WHERE agent_name = @agentName AND board_id = @boardId
        )
        INSERT INTO agent_boards (agent_name, board_id) VALUES (@agentName, @boardId)
      `);
  }
}

/**
 * Remove an agent from a specific board.
 */
export async function removeAgentFromBoard(
  agentName: string,
  boardId: number
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agentName", sql.NVarChar(100), agentName)
    .input("boardId", sql.Int, boardId)
    .query("DELETE FROM agent_boards WHERE agent_name = @agentName AND board_id = @boardId");
  return (result.rowsAffected[0] ?? 0) > 0;
}

/**
 * Replace all board assignments for an agent (set exactly to boardIds).
 */
export async function setAgentBoards(
  agentName: string,
  boardIds: number[]
): Promise<void> {
  const pool = await getPool();
  // Remove all existing
  await pool
    .request()
    .input("agentName", sql.NVarChar(100), agentName)
    .query("DELETE FROM agent_boards WHERE agent_name = @agentName");
  // Add new ones
  for (const boardId of boardIds) {
    await pool
      .request()
      .input("agentName", sql.NVarChar(100), agentName)
      .input("boardId", sql.Int, boardId)
      .query("INSERT INTO agent_boards (agent_name, board_id) VALUES (@agentName, @boardId)");
  }
}
