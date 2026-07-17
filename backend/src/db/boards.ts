import { getPool, sql } from "./connection.js";
import type { Board, CreateBoardInput, Task } from "../types.js";

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

export async function getBoardWithTasks(id: number): Promise<Board | null> {
  const pool = await getPool();

  const boardResult = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM boards WHERE id = @id");

  if (boardResult.recordset.length === 0) return null;

  const board = mapRowToBoard(boardResult.recordset[0]);

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
