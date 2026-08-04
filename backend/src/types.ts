// ─── Users & Settings ────────────────────────────────────────────────────────

export interface User {
  id: number;
  email: string;
  /**
   * Profile-level fallback git provider, used for repositories whose provider
   * cannot be determined from their URL and that have no per-tab override.
   * Null means "always derive from the repository URL".
   */
  defaultGitProvider: GitProvider | null;
  createdAt: string;
  updatedAt: string;
  // NOTE: password_hash and kiro_api_key_encrypted are NEVER returned in API responses
}

// ─── Git providers ───────────────────────────────────────────────────────────

/**
 * Supported git hosting providers. Determines which stored credential is used
 * for clone/push and which REST API opens the pull request.
 */
export type GitProvider = "github" | "azure-devops";

export const GIT_PROVIDERS: GitProvider[] = ["github", "azure-devops"];

/** The credential key each provider authenticates with. */
export const GIT_PROVIDER_CREDENTIAL: Record<GitProvider, CredentialKey> = {
  github: "githubPat",
  "azure-devops": "azureDevOpsPat",
};

export function isGitProvider(value: unknown): value is GitProvider {
  return value === "github" || value === "azure-devops";
}

/**
 * Best-effort provider detection from a repository URL.
 * Returns null for hosts we don't recognise (self-hosted GitHub Enterprise,
 * on-prem Azure DevOps Server, GitLab, …) — those need an explicit selection.
 */
export function detectGitProviderFromUrl(url: string | null | undefined): GitProvider | null {
  if (!url) return null;
  if (url.includes("github.com")) return "github";
  if (url.includes("dev.azure.com") || url.includes("visualstudio.com")) return "azure-devops";
  return null;
}

/**
 * Resolve the provider to use for a repository.
 *
 * Precedence: explicit per-tab choice → profile default → URL detection.
 * An explicit choice wins over the URL so self-hosted hosts can be used at all.
 */
export function resolveGitProvider(
  tabProvider: GitProvider | null | undefined,
  userDefault: GitProvider | null | undefined,
  repositoryUrl: string | null | undefined
): GitProvider | null {
  return tabProvider ?? userDefault ?? detectGitProviderFromUrl(repositoryUrl);
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
  | "awsSecretAccessKey"
  | "githubPat";

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
  branch: string | null;
  pullRequestUrl: string | null;
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
  /**
   * Git provider for this tab's repository. Null means "inherit": fall back to
   * the owner's profile default, then to URL detection.
   */
  gitProvider: GitProvider | null;
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

export type AgentKind = "editor" | "inspector";

export interface Agent {
  id: number;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  allowedTools: string[];
  toolsSettings: Record<string, unknown>;
  resources: string[];
  kind: AgentKind;
  claimState: string;
  workingState: string;
  resolveState: string;
  tabIds?: number[];
  userId: number;
  /**
   * The task state this agent claims FROM (e.g. "todo" for dev, "developed" for reviewer).
   * Defaults to "todo" if the column is not yet populated (pre-migration compat).
   */
  claimState: string;
  /**
   * The task state set while the agent is actively working (e.g. "in-progress").
   * Defaults to "in-progress" if the column is not yet populated.
   */
  workingState: string;
  /**
   * The task state set on successful completion (e.g. "developed" for dev, "reviewed" for reviewer).
   * Defaults to "developed" if the column is not yet populated.
   */
  resolveState: string;
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
  kind?: AgentKind;
  claimState?: string;
  workingState?: string;
  resolveState?: string;
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
  kind?: AgentKind;
  claimState?: string;
  workingState?: string;
  resolveState?: string;
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
  gitProvider?: GitProvider | null;
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
  id: number;
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
  /**
   * True for the one permanent, agentless "Chat" session every user gets.
   * Pinned sessions are always sorted first in the UI and cannot be deleted.
   * Never settable through the public create-session API — only internal
   * code (registration / startup backfill) may set this.
   */
  pinned: boolean;
  /**
   * Cumulative Kiro credits consumed across all prompt turns since this
   * session was last started. Reset to 0 on each start.
   */
  totalCreditsUsed?: number;
}

export interface CreateSessionInput {
  name: string;
  agent?: string;
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
  /**
   * Internal-only flag for creating the permanent pinned "Chat" session.
   * Not accepted from the public POST /api/sessions body — the route strips it.
   */
  pinned?: boolean;
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
  | { type: "agent-deleted"; agentId: number }
  | { type: "session-created"; session: Session }
  | { type: "session-updated"; session: Session }
  | { type: "session-deleted"; sessionId: number }
  | { type: "session-output"; sessionId: number; entry: OutputEntry }
  | { type: "session-activity"; sessionId: number; activity: Activity }
  | { type: "error-created"; error: AgentError }
  | { type: "error-dismissed"; errorId: string }
  | { type: "errors-cleared" }
  | { type: "connected"; message: string };

// ─── Agent Errors ────────────────────────────────────────────────────────────

export interface AgentError {
  id: string;
  sessionId: number;
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
  /** Owner user ID — errors belong to the account that owns the session */
  userId: number;
}

export type WsClientMessage =
  | { action: "subscribe"; tabId?: number }
  | { action: "session-start"; sessionId: number }
  | { action: "session-stop"; sessionId: number }
  | { action: "session-prompt"; sessionId: number; text: string }
  | { action: "session-get-output"; sessionId: number }
  | { action: "ping" };
