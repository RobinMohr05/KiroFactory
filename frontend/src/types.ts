export interface Tab {
  id: number;
  name: string;
  repositoryUrl?: string | null;
  gitProvider?: string | null;
  mcpConfig?: McpConfig;
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
  id: number;
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
  | { type: 'error-created'; error: AgentError }
  | { type: 'error-dismissed'; errorId: number }
  | { type: 'errors-cleared' }
  | { type: 'connected' };
