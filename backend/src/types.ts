// ─── Tasks & Boards ──────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  state: "todo" | "in-progress" | "developed";
  description: string;
  files: string[];
  origin: "user" | "ai" | "user-assisted";
  createdAt: string;
  updatedAt: string;
  boards?: Board[];
}

export interface Board {
  id: number;
  name: string;
  createdAt: string;
  tasks?: Task[];
}

export interface TaskBoard {
  taskId: number;
  boardId: number;
}

// ─── API Request/Response types ──────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  description?: string;
  files?: string[];
  origin?: "user" | "ai" | "user-assisted";
  boardIds?: number[];
}

export interface UpdateTaskInput {
  title?: string;
  priority?: 1 | 2 | 3 | 4;
  type?: "improvement" | "bug" | "feature";
  state?: "todo" | "in-progress" | "developed";
  description?: string;
  files?: string[];
}

export interface CreateBoardInput {
  name: string;
}

// ─── Sessions (ACP Agent Runner) ─────────────────────────────────────────────

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface OutputEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface Activity {
  type: "idle" | "working" | "tool-call" | "thinking" | "completed";
  detail?: string;
}

export interface Session {
  id: string;
  name: string;
  agent: string;
  status: "stopped" | "running" | "error" | "completed";
  prompt: string;
  interactive: boolean;
  cwd: string;
  timeoutSeconds: number;
  model?: string;
  mcpServers?: McpServerConfig[];
  createdAt: string;
  startedAt?: string;
  output: OutputEntry[];
  currentActivity?: Activity;
}

export interface CreateSessionInput {
  name: string;
  agent: string;
  prompt?: string;
  cwd?: string;
  timeoutSeconds?: number;
  model?: string;
  interactive?: boolean;
  mcpServers?: McpServerConfig[];
}

// ─── WebSocket Messages ──────────────────────────────────────────────────────

export type WsServerMessage =
  | { type: "task-created"; task: Task }
  | { type: "task-updated"; task: Task }
  | { type: "task-deleted"; taskId: number }
  | { type: "board-created"; board: Board }
  | { type: "board-updated"; board: Board }
  | { type: "board-deleted"; boardId: number }
  | { type: "session-created"; session: Session }
  | { type: "session-updated"; session: Session }
  | { type: "session-deleted"; sessionId: string }
  | { type: "session-output"; sessionId: string; entry: OutputEntry }
  | { type: "session-activity"; sessionId: string; activity: Activity }
  | { type: "connected"; message: string };

export type WsClientMessage =
  | { action: "subscribe"; boardId?: number }
  | { action: "session-start"; sessionId: string }
  | { action: "session-stop"; sessionId: string }
  | { action: "session-prompt"; sessionId: string; text: string }
  | { action: "session-get-output"; sessionId: string }
  | { action: "ping" };
