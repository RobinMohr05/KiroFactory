// ─── Users & Settings ────────────────────────────────────────────────────────

export interface User {
  id: number;
  email: string;
  createdAt: string;
  updatedAt: string;
  // NOTE: password_hash and kiro_api_key_encrypted are NEVER returned in API responses
}

export interface CreateUserInput {
  email: string;
  password: string;
  kiroApiKey: string;
}

export interface AppSettings {
  registrationEnabled: boolean;
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/** All supported credential keys stored encrypted per user. */
export type CredentialKey =
  | "azureDevOpsPat"
  | "atlassianApiToken"
  | "atlassianUsername"
  | "awsAccessKeyId"
  | "awsSecretAccessKey";

/** Status response: which credentials are set (true) vs. unset (false). Never returns values. */
export type CredentialStatus = Record<CredentialKey, boolean>;

// ─── Authenticated Request ───────────────────────────────────────────────────

/**
 * Extends Express Request with authenticated user context.
 * Populated by auth middleware (once implemented).
 */
export interface AuthenticatedRequest {
  userId: number;
}

// ─── Tasks & Tabs ────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  state: string;
  description: string;
  files: string[];
  origin: "user" | "ai" | "user-assisted";
  createdAt: string;
  updatedAt: string;
  tabs?: Tab[];
}

/** MCP server toggle configuration per tab/board */
export interface TabMcpConfig {
  atlassian: boolean;
  azureDevops: boolean;
  awsApi: boolean;
  awsDocs: boolean;
}

export const DEFAULT_MCP_CONFIG: TabMcpConfig = {
  atlassian: true,
  azureDevops: true,
  awsApi: false,
  awsDocs: true,
};

export interface Tab {
  id: number;
  name: string;
  repositoryUrl?: string | null;
  mcpConfig: TabMcpConfig;
  columns: string[];
  sortOrder: number;
  userId: number;
  createdAt: string;
  tasks?: Task[];
  /** Sessions assigned to this tab (populated on demand) */
  sessions?: Pick<Session, "id" | "name" | "agent" | "status">[];
  /** Agent names assigned to this tab (populated on demand) */
  agents?: string[];
  /** Errors associated with this tab (populated on demand) */
  errors?: AgentError[];
}

export interface TaskTab {
  taskId: number;
  tabId: number;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface Agent {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  allowedTools: string[];
  toolsSettings: Record<string, unknown>;
  resources: string[];
  tabIds?: number[];
  userId: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  userId: number;
  description?: string;
  prompt?: string;
  tools?: string[];
  allowedTools?: string[];
  toolsSettings?: Record<string, unknown>;
  resources?: string[];
  tabIds?: number[];
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  allowedTools?: string[];
  toolsSettings?: Record<string, unknown>;
  resources?: string[];
  tabIds?: number[];
}

// ─── API Request/Response types ──────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "improvement" | "bug" | "feature";
  description?: string;
  files?: string[];
  origin?: "user" | "ai" | "user-assisted";
  tabIds?: number[];
}

export interface UpdateTaskInput {
  title?: string;
  priority?: 1 | 2 | 3 | 4;
  type?: "improvement" | "bug" | "feature";
  state?: string;
  description?: string;
  files?: string[];
}

export interface CreateTabInput {
  name: string;
  userId: number;
  repositoryUrl?: string;
  columns?: string[];
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
  loop: boolean;
  runs: number;
  intervalSeconds: number;
  cwd: string;
  timeoutSeconds: number;
  model?: string;
  mcpServers?: McpServerConfig[];
  /** Per-session MCP server toggle overrides. Nullable = inherit from tab. Merges over tab defaults (override wins). */
  mcpConfigOverride?: TabMcpConfig | null;
  /** Tab memberships — session appears on these tabs; loop mode claims tasks from them */
  tabIds?: number[];
  /** Owner user ID (for multi-tenant isolation) */
  userId: number;
  createdAt: string;
  startedAt?: string;
  output: OutputEntry[];
  currentActivity?: Activity;
  /** Currently claimed task ID (while in loop mode) */
  currentTaskId?: number;
}

export interface CreateSessionInput {
  name: string;
  agent: string;
  prompt?: string;
  cwd?: string;
  timeoutSeconds?: number;
  model?: string;
  interactive?: boolean;
  loop?: boolean;
  runs?: number;
  intervalSeconds?: number;
  mcpServers?: McpServerConfig[];
  /** Per-session MCP server toggle overrides. Nullable = inherit from tab. Merges over tab defaults (override wins). */
  mcpConfigOverride?: TabMcpConfig | null;
  /** Tab memberships — session appears on these tabs; loop mode claims tasks from them */
  tabIds?: number[];
  /** Owner user ID (for multi-tenant isolation) */
  userId?: number;
}

// ─── WebSocket Messages ──────────────────────────────────────────────────────

export type WsServerMessage =
  | { type: "task-created"; task: Task }
  | { type: "task-updated"; task: Task }
  | { type: "task-deleted"; taskId: number }
  | { type: "tab-created"; tab: Tab }
  | { type: "tab-updated"; tab: Tab }
  | { type: "tab-deleted"; tabId: number }
  | { type: "tabs-reordered"; tabs: Tab[] }
  | { type: "agent-created"; agent: Agent }
  | { type: "agent-updated"; agent: Agent }
  | { type: "agent-deleted"; agentName: string }
  | { type: "session-created"; session: Session }
  | { type: "session-updated"; session: Session }
  | { type: "session-deleted"; sessionId: string }
  | { type: "session-output"; sessionId: string; entry: OutputEntry }
  | { type: "session-activity"; sessionId: string; activity: Activity }
  | { type: "error-created"; error: AgentError }
  | { type: "connected"; message: string };

// ─── Agent Errors ────────────────────────────────────────────────────────────

export interface AgentError {
  id: string;
  sessionId: string;
  sessionName: string;
  agent: string;
  timestamp: string;
  message: string;
  context: string;
  taskId?: number;
  taskTitle?: string;
  taskCreated: boolean;
  createdTaskId?: number;
  /** Tab IDs this error is associated with (inherited from session at time of error) */
  tabIds?: number[];
}

export type WsClientMessage =
  | { action: "subscribe"; tabId?: number }
  | { action: "session-start"; sessionId: string }
  | { action: "session-stop"; sessionId: string }
  | { action: "session-prompt"; sessionId: string; text: string }
  | { action: "session-get-output"; sessionId: string }
  | { action: "ping" };
