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
  /**
   * Which top-level UI layout the user sees. "easy" is a simplified,
   * session-only view aimed at people just getting into loop engineering;
   * "advanced" is the full app (tabs/boards, sessions, agents, errors, usage).
   * Defaults to "easy" for new accounts. Switching requires explicit
   * confirmation client-side (see ViewModeSlider) since "advanced" exposes
   * loop engineering concepts some users are still wary of.
   */
  uiViewMode: UiViewMode;
  createdAt: string;
  updatedAt: string;
  // NOTE: password_hash and kiro_api_key_encrypted are NEVER returned in API responses
}

/**
 * Top-level UI layout mode. Currently two stops, but the slider/persistence
 * plumbing is written to extend to additional modes later (see
 * ViewModeSlider's `steps` prop) — do not assume exactly two values when
 * adding new call sites.
 */
export type UiViewMode = "easy" | "advanced";

export const UI_VIEW_MODES: UiViewMode[] = ["easy", "advanced"];

export function isUiViewMode(value: unknown): value is UiViewMode {
  return typeof value === "string" && (UI_VIEW_MODES as string[]).includes(value);
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
  /** Optional group identifier — tasks sharing the same groupId are worked on the same branch/PR. */
  groupId: string | null;
  createdAt: string;
  updatedAt: string;
  tabs?: Tab[];
  /**
   * IDs of the other tasks this task depends on (DEPENDS_ON edges). Always
   * populated by every db/tasks.ts read path (empty array if none) — see
   * .kiro/specs/neo4j-migration/design.md, "Task dependencies".
   */
  dependsOn?: number[];
  /**
   * True if at least one dependency (see `dependsOn`) is not yet in the
   * "done" state. Never stored — always computed at read time from the
   * current state of this task's dependencies, so it can never go stale.
   */
  isBlocked?: boolean;
  /** The specific dependencies causing `isBlocked` (empty if not blocked). */
  blockedBy?: Array<{ id: number; title: string }>;
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
  /**
   * Whether the QA agent should automatically merge approved PRs and delete
   * their source branches. Defaults to false.
   */
  autoMergePrs: boolean;
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

export const AGENT_KINDS: AgentKind[] = ["editor", "inspector"];

export function isAgentKind(value: unknown): value is AgentKind {
  return value === "editor" || value === "inspector";
}


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
  /**
   * Whether this agent requires a task to run. When false, the agent loops on
   * its own prompt without claiming from the task queue.
   * Defaults to true (standard task-claiming behavior).
   */
  requiresTask: boolean;
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
  requiresTask?: boolean;
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
  requiresTask?: boolean;
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
  /** IDs of other tasks this task depends on. Rejected if it would create a cycle. */
  dependsOn?: number[];
  /** Group identifier — tasks sharing the same groupId are worked on the same branch/PR. */
  groupId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  priority?: 1 | 2 | 3 | 4;
  type?: "improvement" | "bug" | "feature";
  state?: string;
  description?: string;
  files?: string[];
  /** Editable only from the edit-task view — never accepted on task creation. */
  branch?: string | null;
  /** Editable only from the edit-task view — never accepted on task creation. */
  pullRequestUrl?: string | null;
  /** IDs of other tasks this task depends on. Rejected if it would create a cycle. */
  dependsOn?: number[];
  /** Group identifier — tasks sharing the same groupId are worked on the same branch/PR. */
  groupId?: string | null;
}

/**
 * Thrown by db/tasks.ts when a requested `dependsOn` write would introduce a
 * dependency cycle (directly or transitively). Routes should catch this and
 * respond 409, naming the conflicting task IDs.
 */
export class DependencyCycleError extends Error {
  constructor(public readonly fromId: number, public readonly toId: number) {
    super(`Adding a dependency from task ${fromId} to task ${toId} would create a cycle`);
    this.name = "DependencyCycleError";
  }
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
  /**
   * Raw MCP server entries (HTTP or other non-stdio shapes) passed directly
   * to the ACP session/new mcpServers payload. Used by the task planner to
   * attach an HTTP MCP server for GitHub repo access.
   */
  rawMcpServers?: unknown[];
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
  /** Title of the currently claimed task (persisted alongside currentTaskId) */
  currentTaskTitle?: string;
  /**
   * True for the one permanent, agentless "Chat" session every user gets.
   * Pinned sessions are always sorted first in the UI and cannot be deleted.
   * Never settable through the public create-session API — only internal
   * code (registration / startup backfill) may set this.
   */
  pinned: boolean;
  /**
   * True for sessions that are permanent and cannot be unpinned or deleted
   * (e.g., the auto-created "Chat" session). More robust than checking by
   * name, since users could create sessions with the same name.
   * Never settable through the public create-session API.
   */
  isPermanent: boolean;
  /** Sort order within the session list (pinned DESC, sortOrder ASC). */
  sortOrder: number;
  /**
   * Cumulative Kiro credits consumed across all prompt turns since this
   * session was last started. Reset to 0 on each start.
   */
  totalCreditsUsed?: number;
  /**
   * When true, the session always runs locally (via KiroRunner child process)
   * even if the global worker mode is "remote" (ACA_MODE). Used by the task
   * planner which only reads files via MCP and never builds/tests/commits.
   */
  forceLocal?: boolean;
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
  /**
   * Raw MCP server entries (HTTP or other non-stdio shapes) passed directly
   * to the ACP session/new mcpServers payload. Internal-only — not accepted
   * from the public POST /api/sessions body.
   */
  rawMcpServers?: unknown[];
  /** Tab memberships — session appears on these tabs; loop mode claims tasks from them */
  tabIds?: number[];
  /** Owner user ID (for multi-tenant isolation) */
  userId?: number;
  /**
   * Internal-only flag for creating the permanent pinned "Chat" session.
   * Not accepted from the public POST /api/sessions body — the route strips it.
   */
  pinned?: boolean;
  /**
   * Internal-only flag marking the session as permanent (cannot be unpinned or deleted).
   * Not accepted from the public POST /api/sessions body — the route strips it.
   */
  isPermanent?: boolean;
  /**
   * Internal-only flag forcing the session to run locally (via KiroRunner) even
   * when ACA_MODE / WORKER_MODE=remote is active. Used by the task planner,
   * which only needs to chat and read files — never build, test, or commit.
   * Not accepted from the public POST /api/sessions body.
   */
  forceLocal?: boolean;
}

/**
 * Fields that can be updated on an existing session via PATCH /api/sessions/:id.
 * `agent` is intentionally excluded — it is fixed at creation time.
 * Internal/lifecycle fields (id, status, userId, createdAt, startedAt, currentTaskId,
 * currentActivity, pinned, output) are also excluded.
 */
export interface UpdateSessionInput {
  name?: string;
  prompt?: string;
  cwd?: string | null;
  model?: string | null;
  timeoutSeconds?: number;
  interactive?: boolean;
  loop?: boolean;
  runs?: number;
  intervalSeconds?: number;
  mcpServers?: McpServerConfig[] | null;
  mcpConfigOverride?: TabMcpConfig | null;
  tabIds?: number[];
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
  | { type: "sessions-reordered"; sessions: Session[] }
  | { type: "session-output"; sessionId: number; entry: OutputEntry }
  | { type: "session-activity"; sessionId: number; activity: Activity }
  | { type: "session-turn-start"; sessionId: number; turnNumber: number; taskId?: number; taskTitle?: string; startedAt: string }
  | { type: "session-turn-end"; sessionId: number; turnNumber: number; summary: TurnEndSummary }
  | { type: "session-tool-call"; sessionId: number; turnNumber: number; toolCallId: string; label: string; icon: string; status: "running" }
  | { type: "session-tool-call-update"; sessionId: number; turnNumber: number; toolCallId: string; status: "completed" | "failed"; output?: string; durationMs?: number }
  | { type: "error-created"; error: AgentError }
  | { type: "error-dismissed"; errorId: string }
  | { type: "errors-cleared" }
  | { type: "connected"; message: string };

// ─── Turn Summary (used in session-turn-end WS event) ────────────────────────

export interface TurnEndSummary {
  credits: number;
  costEur: number;
  verdict?: string;
  durationMs: number;
  toolCallCount: number;
  hasChanges: boolean;
  prUrl?: string;
  branchName?: string;
}

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
