export interface Tab {
  id: number;
  name: string;
  repositoryUrl?: string | null;
  gitProvider?: string | null;
  mcpConfig?: McpConfig;
  autoMergePrs?: boolean;
  sortOrder?: number;
}

export interface McpConfig {
  atlassian: boolean;
  azureDevops: boolean;
  awsApi: boolean;
  awsDocs: boolean;
}

export interface Task {
  id: number;
  title: string;
  description?: string;
  type: 'improvement' | 'bug' | 'feature';
  priority: number;
  state: TaskState;
  origin?: 'user' | 'ai' | 'user-assisted';
  branch?: string | null;
  pullRequestUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
  isBlocked?: boolean;
  blockedBy?: { id: number; title: string }[];
  dependsOn?: number[];
  tabs?: { id: number; name: string }[];
}

export type TaskState = 'todo' | 'in-progress' | 'developed' | 'in-code-review' | 'reviewed' | 'in-qa' | 'done';

export interface Session {
  id: number;
  name: string;
  agent?: string;
  status: 'running' | 'stopped';
  prompt?: string;
  cwd?: string;
  model?: string;
  interactive?: boolean;
  loop?: boolean;
  runs?: number;
  intervalSeconds?: number;
  tabIds?: number[];
  pinned?: boolean;
  isPermanent?: boolean;
  sortOrder?: number;
  currentActivity?: SessionActivity;
  totalCreditsUsed?: number;
  mcpConfigOverride?: McpConfig;
  mcpServers?: McpServerConfig[];
  timeoutSeconds?: number;
}

export interface SessionActivity {
  type: string;
  detail?: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface OutputEntry {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp?: string;
}

// ─── Turn-level data (from /api/sessions/:id/turns and WebSocket events) ─────

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

/** Live tool call state tracked client-side during a turn */
export interface ToolCallEntry {
  id: string;
  label: string;
  icon: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  durationMs?: number;
}

/** A turn in the timeline, combining persisted data with live streaming state */
export interface TimelineTurn {
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
  /** Live tool calls streamed via WebSocket */
  toolCalls: ToolCallEntry[];
  /** Whether this turn is currently in progress */
  isActive: boolean;
}

export interface Agent {
  id: number;
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  allowedTools?: string[];
  resources?: string[];
  toolsSettings?: Record<string, unknown>;
  kind?: 'editor' | 'inspector';
  requiresTask?: boolean;
  claimState?: string | null;
  workingState?: string | null;
  resolveState?: string | null;
}

export interface AgentError {
  id: string;
  message: string;
  context: string;
  agent: string;
  sessionName: string;
  taskId?: number;
  taskTitle?: string;
  timestamp: string;
  taskCreated?: boolean;
  createdTaskId?: number;
}

export interface User {
  id: number;
  email: string;
  createdAt: string;
  defaultGitProvider?: string | null;
}

export type ViewTab = 'boards' | 'sessions' | 'agents' | 'errors';

export type WsMessage =
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'task-deleted'; taskId: number }
  | { type: 'tab-created'; tab: Tab }
  | { type: 'tab-updated'; tab: Tab }
  | { type: 'tab-deleted'; tabId: number }
  | { type: 'tabs-reordered'; tabs: Tab[] }
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: number }
  | { type: 'sessions-reordered'; sessions: Session[] }
  | { type: 'session-output'; sessionId: number; entry: OutputEntry }
  | { type: 'session-activity'; sessionId: number; activity: SessionActivity }
  | { type: 'session-turn-start'; sessionId: number; turnNumber: number; taskId?: number; taskTitle?: string; startedAt: string }
  | { type: 'session-turn-end'; sessionId: number; turnNumber: number; summary: TurnEndSummary }
  | { type: 'session-tool-call'; sessionId: number; turnNumber: number; toolCallId: string; label: string; icon: string; status: 'running' }
  | { type: 'session-tool-call-update'; sessionId: number; turnNumber: number; toolCallId: string; status: 'completed' | 'failed'; output?: string; durationMs?: number }
  | { type: 'error-created'; error: AgentError }
  | { type: 'error-dismissed'; errorId: string }
  | { type: 'errors-cleared' }
  | { type: 'connected' };
