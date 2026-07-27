import { getPool, sql } from "./connection.js";
import type { Task, CreateTaskInput, UpdateTaskInput } from "../types.js";
import { DEFAULT_MCP_CONFIG, isGitProvider } from "../types.js";

/**
 * Map a raw DB row to a Task object.
 * Parses the JSON `files` column and converts snake_case to camelCase.
 */
function mapRowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    title: row.title as string,
    priority: row.priority as 1 | 2 | 3 | 4,
    type: row.type as Task["type"],
    state: row.state as string,
    description: row.description as string,
    files: JSON.parse((row.files as string) || "[]"),
    origin: row.origin as Task["origin"],
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Attach tab memberships to a list of tasks (batch lookup).
 */
async function attachTabs(tasks: Task[]): Promise<Task[]> {
  if (tasks.length === 0) return tasks;

  const pool = await getPool();
  const taskIds = tasks.map((t) => t.id);

  const result = await pool.request().query(`
    SELECT tt.task_id, t.id, t.name, t.repository_url, t.git_provider, t.sort_order, t.user_id, t.created_at
    FROM task_tabs tt
    INNER JOIN tabs t ON t.id = tt.tab_id
    WHERE tt.task_id IN (${taskIds.join(",")})
  `);

  const tabsByTask = new Map<number, Task["tabs"]>();
  for (const row of result.recordset) {
    const taskId = row.task_id as number;
    if (!tabsByTask.has(taskId)) tabsByTask.set(taskId, []);
    tabsByTask.get(taskId)!.push({
      id: row.id as number,
      name: row.name as string,
      repositoryUrl: (row.repository_url as string) || null,
      gitProvider: isGitProvider(row.git_provider) ? row.git_provider : null,
      mcpConfig: { ...DEFAULT_MCP_CONFIG },
      columns: [],
      sortOrder: (row.sort_order as number) ?? 0,
      userId: row.user_id as number,
      createdAt: (row.created_at as Date).toISOString(),
    });
  }

  for (const task of tasks) {
    task.tabs = tabsByTask.get(task.id) ?? [];
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isTaskOwnedByUser(
  taskId: number,
  userId: number
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("taskId", sql.Int, taskId)
    .input("userId", sql.Int, userId)
    .query(`
      SELECT 1 FROM task_tabs tt
      INNER JOIN tabs t ON t.id = tt.tab_id
      WHERE tt.task_id = @taskId AND t.user_id = @userId
    `);
  return result.recordset.length > 0;
}

export async function getAllTasks(
  filters?: { state?: string; priority?: number; tabId?: number; userId?: number }
): Promise<Task[]> {
  const pool = await getPool();
  const request = pool.request();

  const conditions: string[] = [];

  if (filters?.state) {
    request.input("state", sql.VarChar(50), filters.state);
    conditions.push("t.state = @state");
  }
  if (filters?.priority) {
    request.input("priority", sql.TinyInt, filters.priority);
    conditions.push("t.priority = @priority");
  }
  if (filters?.tabId) {
    request.input("tabId", sql.Int, filters.tabId);
    conditions.push(
      "EXISTS (SELECT 1 FROM task_tabs tt WHERE tt.task_id = t.id AND tt.tab_id = @tabId)"
    );
  }
  if (filters?.userId) {
    request.input("userId", sql.Int, filters.userId);
    conditions.push(
      "EXISTS (SELECT 1 FROM task_tabs tt INNER JOIN tabs tab ON tab.id = tt.tab_id WHERE tt.task_id = t.id AND tab.user_id = @userId)"
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await request.query(`
    SELECT t.* FROM tasks t ${where} ORDER BY t.priority ASC, t.created_at DESC
  `);

  const tasks = result.recordset.map(mapRowToTask);
  return attachTabs(tasks);
}

export async function getTaskById(id: number): Promise<Task | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("SELECT * FROM tasks WHERE id = @id");

  if (result.recordset.length === 0) return null;

  const task = mapRowToTask(result.recordset[0]);
  await attachTabs([task]);
  return task;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const pool = await getPool();

  const filesJson = JSON.stringify(input.files ?? []);
  const origin = input.origin ?? "user";

  const result = await pool
    .request()
    .input("title", sql.NVarChar(200), input.title)
    .input("priority", sql.TinyInt, input.priority)
    .input("type", sql.VarChar(20), input.type)
    .input("description", sql.NVarChar(sql.MAX), input.description ?? "")
    .input("files", sql.NVarChar(sql.MAX), filesJson)
    .input("origin", sql.VarChar(20), origin)
    .query(`
      INSERT INTO tasks (title, priority, type, state, description, files, origin)
      OUTPUT INSERTED.*
      VALUES (@title, @priority, @type, 'todo', @description, @files, @origin)
    `);

  const task = mapRowToTask(result.recordset[0]);

  if (input.tabIds && input.tabIds.length > 0) {
    await assignTaskToTabs(task.id, input.tabIds);
  }

  await attachTabs([task]);
  return task;
}

export async function updateTask(
  id: number,
  input: UpdateTaskInput
): Promise<Task | null> {
  const pool = await getPool();
  const request = pool.request().input("id", sql.Int, id);

  const setClauses: string[] = ["updated_at = GETUTCDATE()"];

  if (input.title !== undefined) {
    request.input("title", sql.NVarChar(200), input.title);
    setClauses.push("title = @title");
  }
  if (input.priority !== undefined) {
    request.input("priority", sql.TinyInt, input.priority);
    setClauses.push("priority = @priority");
  }
  if (input.type !== undefined) {
    request.input("type", sql.VarChar(20), input.type);
    setClauses.push("type = @type");
  }
  if (input.state !== undefined) {
    request.input("state", sql.VarChar(50), input.state);
    setClauses.push("state = @state");
  }
  if (input.description !== undefined) {
    request.input("description", sql.NVarChar(sql.MAX), input.description);
    setClauses.push("description = @description");
  }
  if (input.files !== undefined) {
    request.input("files", sql.NVarChar(sql.MAX), JSON.stringify(input.files));
    setClauses.push("files = @files");
  }

  const result = await request.query(`
    UPDATE tasks
    SET ${setClauses.join(", ")}
    OUTPUT INSERTED.*
    WHERE id = @id
  `);

  if (result.recordset.length === 0) return null;

  const task = mapRowToTask(result.recordset[0]);
  await attachTabs([task]);
  return task;
}

export async function deleteTask(id: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.Int, id)
    .query("DELETE FROM tasks WHERE id = @id");

  return (result.rowsAffected[0] ?? 0) > 0;
}

export async function assignTaskToTabs(
  taskId: number,
  tabIds: number[]
): Promise<Task | null> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input("taskId", sql.Int, taskId)
      .query("DELETE FROM task_tabs WHERE task_id = @taskId");

    for (const tabId of tabIds) {
      await new sql.Request(transaction)
        .input("taskId", sql.Int, taskId)
        .input("tabId", sql.Int, tabId)
        .query("INSERT INTO task_tabs (task_id, tab_id) VALUES (@taskId, @tabId)");
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }

  return getTaskById(taskId);
}

export async function removeTaskFromTab(
  taskId: number,
  tabId: number
): Promise<Task | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("taskId", sql.Int, taskId)
    .input("tabId", sql.Int, tabId)
    .query("DELETE FROM task_tabs WHERE task_id = @taskId AND tab_id = @tabId");

  if ((result.rowsAffected[0] ?? 0) === 0) return null;
  return getTaskById(taskId);
}

export async function getChangedTasksSince(since: string): Promise<Task[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("since", sql.DateTime2, since)
    .query("SELECT * FROM tasks WHERE updated_at > @since ORDER BY updated_at ASC");

  const tasks = result.recordset.map(mapRowToTask);
  return attachTabs(tasks);
}
