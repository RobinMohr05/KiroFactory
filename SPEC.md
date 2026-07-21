# KiroFactory — Kiro ACP Session Manager

## Spec Sheet

---

## 1. Overview

KiroFactory is a web-based manager for creating, running, and monitoring **Kiro ACP sessions** directly from a browser dashboard. Inspired by the TecFactory architecture in the [ValueModeller](https://github.com/RobinMohr/ValueModeller) project, it provides a centralized control plane for orchestrating multiple autonomous AI agent sessions powered by the Kiro Agent Client Protocol (ACP).

**Core idea:** A lightweight Node.js server spawns and manages `kiro-cli acp` subprocesses, streams their output to connected browser clients in real-time via WebSocket, and exposes a REST API for full CRUD lifecycle management of sessions.

---

## 2. Architecture (Inspired by TecFactory)

### 2.1 What TecFactory Does

TecFactory is a WebSocket-based web UI that monitors and controls autonomous Kiro ACP agent loops. Its architecture:

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (vanilla HTML/CSS/JS)                              │
│  - Tabs: Agents | Tasks | Errors                            │
│  - WebSocket client for real-time updates                   │
│  - REST calls for CRUD operations                           │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP + WebSocket (port 3500)
┌────────────────────────▼────────────────────────────────────┐
│  Express + WebSocket Server (server.js)                     │
│  - REST API: /api/agents, /api/tasks, /api/errors           │
│  - WebSocket: broadcast agent output, status, activity      │
│  - Process manager: spawn/kill agent-loop.js subprocesses   │
│  - Task file watcher (fs.watch on tasks/ directory)         │
│  - Agents config: agents.json (persisted)                   │
└────────────────────────┬────────────────────────────────────┘
                         │ child_process.spawn
┌────────────────────────▼────────────────────────────────────┐
│  Agent Loop (agent-loop.js / TypeScript compiled)           │
│  - CLI args: --agent, --type, --interval, --timeout, etc.   │
│  - Task claiming with atomic lock files                     │
│  - Iteration loop with configurable interval/timeout        │
│  - Git operations (branch, commit, push)                    │
│  - Error logging to errors/ folder                          │
└────────────────────────┬────────────────────────────────────┘
                         │ child_process.spawn (kiro-cli acp)
┌────────────────────────▼────────────────────────────────────┐
│  KiroRunner (ACP Client Wrapper)                            │
│  - Spawns `kiro-cli acp --agent <name>`                     │
│  - NDJSON over stdio (stdin/stdout)                         │
│  - ACP SDK: handshake, session create, prompt, cancel       │
│  - Auto-approves all tool permissions                       │
│  - Streams SessionUpdate events as async generator          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Key Technologies Used

| Layer | Technology |
|-------|-----------|
| Server | Node.js, Express 4, `ws` (WebSocket) |
| ACP Communication | `@agentclientprotocol/sdk` ^0.19.0, NDJSON/stdio |
| Process Management | `child_process.spawn`, taskkill (Windows) |
| Persistence | JSON files on disk (agents.json, tasks/*.json) |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Build | TypeScript (scripts), ES Modules |
| Testing | Vitest, supertest |

### 2.3 Key Design Patterns

1. **Subprocess-per-agent** — Each agent runs as an isolated Node.js process that internally spawns `kiro-cli acp`
2. **Line-buffered streaming** — stdout/stderr are buffered to emit complete lines, not token fragments
3. **WebSocket broadcast** — All connected clients receive real-time updates (multi-tab sync)
4. **Atomic task claiming** — File-based locks (`*.lock`) prevent multiple agents from claiming the same task
5. **Graceful shutdown with rollback** — Stop an agent and optionally revert uncommitted changes + reset task states
6. **Activity inference** — Agent type determines how to parse output into human-readable activity status

---

## 3. KiroFactory — Target System Design

### 3.1 Goals

- **Create** Kiro ACP sessions on demand from a browser UI
- **Configure** sessions with agent names, prompts, MCP servers, timeouts
- **Start/Stop** sessions with process lifecycle management
- **Stream** real-time session output (agent messages, tool calls) to the browser
- **Monitor** multiple concurrent sessions from a single dashboard
- **Manage** a queue of prompts/tasks to feed into sessions
- **Persist** session configurations for reuse

### 3.2 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser UI (React or Vanilla)                              │
│  - Tabs: Boards | Sessions                                  │
│  - Board View: Kanban columns per board (drag-and-drop)     │
│  - Session list with status indicators                      │
│  - Session creation wizard (agent, prompt, MCP, timeout)    │
│  - Real-time log viewer per session                         │
│  - Prompt input: send follow-up prompts to active sessions  │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP + WebSocket
┌────────────────────────▼────────────────────────────────────┐
│  KiroFactory Server (Node.js / Express / ws)                │
│                                                             │
│  REST API:                                                  │
│    ── Sessions ──                                           │
│    POST   /api/sessions            — create new session     │
│    GET    /api/sessions            — list all sessions      │
│    GET    /api/sessions/:id        — get session details    │
│    POST   /api/sessions/:id/prompt — send prompt to session │
│    POST   /api/sessions/:id/stop   — stop session           │
│    DELETE /api/sessions/:id        — delete session config  │
│    GET    /api/templates           — list session templates │
│    POST   /api/templates           — save a template        │
│                                                             │
│    ── Boards ──                                             │
│    GET    /api/boards              — list all boards        │
│    POST   /api/boards              — create board           │
│    GET    /api/boards/:id          — board with tasks       │
│    PUT    /api/boards/:id          — rename board           │
│    DELETE /api/boards/:id          — delete board           │
│                                                             │
│    ── Tasks ──                                              │
│    GET    /api/tasks               — list (filter/sort)     │
│    POST   /api/tasks               — create task            │
│    GET    /api/tasks/:id           — single task + boards   │
│    PUT    /api/tasks/:id           — update task            │
│    DELETE /api/tasks/:id           — delete task            │
│    POST   /api/tasks/:id/boards    — assign to boards       │
│    DELETE /api/tasks/:id/boards/:b — remove from board      │
│                                                             │
│  WebSocket Messages (server → client):                      │
│    { type: "output", sessionId, entry }                     │
│    { type: "status", sessionId, status }                    │
│    { type: "activity", sessionId, activity }                │
│    { type: "task-created", task }                           │
│    { type: "task-updated", task }                           │
│    { type: "task-deleted", taskId }                         │
│    { type: "board-updated", board }                         │
│                                                             │
│  WebSocket Messages (client → server):                      │
│    { action: "start", sessionId }                           │
│    { action: "stop", sessionId }                            │
│    { action: "prompt", sessionId, text }                    │
│    { action: "getOutput", sessionId }                       │
│                                                             │
│  Process Manager:                                           │
│    - Spawns kiro-cli acp per session                        │
│    - Buffers stdout/stderr into complete lines              │
│    - Broadcasts output to all WebSocket clients             │
│    - Handles timeout, crash recovery, cleanup               │
└──────────┬─────────────────────────────────┬────────────────┘
           │ child_process.spawn             │ mssql (TDS)
┌──────────▼──────────────────────┐  ┌──────▼────────────────────────┐
│  KiroRunner (ACP Client)        │  │  SQL Server                    │
│  - kiro-cli acp --agent <name>  │  │  - boards table                │
│  - NDJSON over stdio            │  │  - tasks table                 │
│  - @agentclientprotocol/sdk     │  │  - task_boards junction        │
│  - Async generator streaming    │  │  - Indexed queries for state   │
│  - Auto-approve permissions     │  │  - Transactional updates       │
└─────────────────────────────────┘  └────────────────────────────────┘
```

### 3.3 Core Data Model

#### 3.3.1 Database Schema (SQL Server)

Tasks and boards are persisted in a SQL Server database. The schema supports many-to-many relationships between tasks and boards.

```sql
-- Boards
CREATE TABLE boards (
    id          INT             IDENTITY(1,1) PRIMARY KEY,
    name        NVARCHAR(100)   NOT NULL UNIQUE,
    created_at  DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

INSERT INTO boards (name) VALUES ('generic');

-- Tasks
CREATE TABLE tasks (
    id              INT             IDENTITY(1,1) PRIMARY KEY,
    title           NVARCHAR(200)   NOT NULL,
    priority        TINYINT         NOT NULL CHECK (priority BETWEEN 1 AND 4),
    type            VARCHAR(20)     NOT NULL CHECK (type IN ('improvement', 'problem', 'idea')),
    state           VARCHAR(20)     NOT NULL CHECK (state IN ('todo', 'in-progress', 'developed')),
    description     NVARCHAR(MAX)   NOT NULL DEFAULT '',
    files           NVARCHAR(MAX)   NOT NULL DEFAULT '[]',
    origin          VARCHAR(20)     NOT NULL CHECK (origin IN ('user', 'ai', 'user-assisted')),
    created_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    updated_at      DATETIME2       NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_tasks_todo_priority ON tasks (priority, origin)
WHERE state = 'todo';

-- Junction: tasks <-> boards (many-to-many)
CREATE TABLE task_boards (
    task_id     INT NOT NULL,
    board_id    INT NOT NULL,
    PRIMARY KEY (task_id, board_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);
```

#### 3.3.2 TypeScript Interfaces

```typescript
// ─── Tasks & Boards (SQL Server backed) ─────────────────────────────────────

interface Task {
  id: number;                    // Auto-increment PK
  title: string;                 // Max 200 chars
  priority: 1 | 2 | 3 | 4;     // 1=Critical, 2=High, 3=Medium, 4=Low
  type: "improvement" | "problem" | "idea";
  state: "todo" | "in-progress" | "developed";
  description: string;
  files: string[];               // JSON array of file paths
  origin: "user" | "ai" | "user-assisted";
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  boards: Board[];               // Boards this task belongs to (populated via JOIN)
}

interface Board {
  id: number;                    // Auto-increment PK
  name: string;                  // Unique board name
  createdAt: string;             // ISO timestamp
  tasks?: Task[];                // Tasks on this board (populated on demand)
}

interface TaskBoard {
  taskId: number;
  boardId: number;
}

// ─── Sessions (in-memory + optional persistence) ────────────────────────────

interface Session {
  id: string;                    // Unique ID (8-char hex)
  name: string;                  // Human-readable name
  agent: string;                 // Kiro agent name (from .kiro/agents/)
  status: "stopped" | "running" | "error" | "completed";
  prompt: string;                // Initial prompt text
  cwd: string;                   // Working directory for kiro-cli
  timeoutSeconds: number;        // Max duration per prompt
  model?: string;                // Optional model override
  mcpServers?: McpServerEntry[]; // Optional MCP servers to inject
  trustAllTools: boolean;        // Auto-approve all tool permissions
  createdAt: string;             // ISO timestamp
  startedAt?: string;            // When last started
  output: OutputEntry[];         // Buffered log entries (max N)
  currentActivity?: Activity;    // Parsed activity from output
}

interface OutputEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

interface Activity {
  type: "idle" | "working" | "tool-call" | "thinking" | "completed";
  detail?: string;  // e.g., tool name or task description
}

interface SessionTemplate {
  id: string;
  name: string;
  agent: string;
  prompt: string;
  cwd: string;
  timeoutSeconds: number;
  model?: string;
  mcpServers?: McpServerEntry[];
  trustAllTools: boolean;
}

interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}
```

### 3.4 Tasks & Boards REST API

```
── Boards ──────────────────────────────────────────────────────
GET    /api/boards                — list all boards
POST   /api/boards               — create a board { name }
GET    /api/boards/:id           — get board with its tasks
PUT    /api/boards/:id           — update board { name }
DELETE /api/boards/:id           — delete board (cascade removes task_boards entries)

── Tasks ───────────────────────────────────────────────────────
GET    /api/tasks                — list all tasks (optional ?state=&priority=&boardId=)
POST   /api/tasks                — create task { title, priority, type, description, files, origin, boardIds[] }
GET    /api/tasks/:id            — get single task with board memberships
PUT    /api/tasks/:id            — update task fields (title, priority, type, state, description, files)
DELETE /api/tasks/:id            — delete task (cascade removes from all boards)

── Task ↔ Board Assignment ─────────────────────────────────────
POST   /api/tasks/:id/boards     — assign task to boards { boardIds[] }
DELETE /api/tasks/:id/boards/:boardId — remove task from a board
```

### 3.5 Board View (UI)

The board view is the primary interface for managing tasks. Each board is displayed as a **Kanban-style column view** grouped by task state.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Board: [generic ▼]  [+ New Board]                    [+ New Task]      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─── Todo ──────────┐  ┌─ In Progress ─────┐  ┌── Developed ────────┐ │
│  │                    │  │                    │  │                      │ │
│  │ ┌──────────────┐  │  │ ┌──────────────┐  │  │ ┌──────────────────┐ │ │
│  │ │ P1 ● Fix API │  │  │ │ P2 ● Add auth│  │  │ │ P3 ● Dark mode   │ │ │
│  │ │ improvement  │  │  │ │ problem      │  │  │ │ improvement      │ │ │
│  │ │ 🧑 user      │  │  │ │ 🤖 ai        │  │  │ │ 🧑 user          │ │ │
│  │ └──────────────┘  │  │ └──────────────┘  │  │ └──────────────────┘ │ │
│  │                    │  │                    │  │                      │ │
│  │ ┌──────────────┐  │  │                    │  │                      │ │
│  │ │ P2 ● Refactor│  │  │                    │  │                      │ │
│  │ │ idea         │  │  │                    │  │                      │ │
│  │ │ 🤝 assisted  │  │  │                    │  │                      │ │
│  │ └──────────────┘  │  │                    │  │                      │ │
│  └────────────────────┘  └────────────────────┘  └──────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Board View Features:**

| Feature | Description |
|---------|-------------|
| Board selector | Dropdown to switch between boards; each board shows only its tasks |
| Kanban columns | Tasks grouped by state: Todo → In Progress → Developed |
| Drag-and-drop | Move task cards between columns to change state |
| Inline editing | Click a task card to open an edit panel/modal |
| Task creation | Create new task directly on a board (auto-assigned to current board) |
| Priority badges | Color-coded: P1=red, P2=orange, P3=yellow, P4=gray |
| Origin indicator | Icon showing user/ai/user-assisted origin |
| Filtering | Filter by priority, type, or origin within a board |
| Sorting | Sort by priority (default), creation date, or last modified |
| Board management | Create/rename/delete boards from the UI |
| Multi-board assignment | A task can appear on multiple boards |
| Real-time updates | WebSocket pushes task changes to all connected clients |

**Task Card (expanded on click):**

```
┌──────────────────────────────────────────┐
│ Fix API response caching          [Edit] │
├──────────────────────────────────────────┤
│ Priority: 1 (Critical)                   │
│ Type:     problem                        │
│ Origin:   user                           │
│ State:    todo                           │
│                                          │
│ Description:                             │
│ The API caches stale responses for 5min  │
│ causing inconsistent data on the canvas. │
│                                          │
│ Files:                                   │
│   • src/api/cache-middleware.ts          │
│   • src/store/graph-store.ts             │
│                                          │
│ Boards: generic, sprint-2               │
│                                          │
│ Created: 2026-07-15 10:30 UTC            │
│ Updated: 2026-07-15 14:22 UTC            │
│                                          │
│ [Assign to Board]  [Delete]              │
└──────────────────────────────────────────┘
```

### 3.6 Real-time Bidirectional Sync (Browser ↔ Database)

The board view and the database must be **instantly in sync in both directions:**
- When the user edits something in the browser → it's in the DB immediately
- When something changes in the DB (e.g., an agent creates a task) → it appears in the browser immediately

#### Sync Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   BROWSER → DB (immediate write-through)                                   │
│                                                                            │
│   User action (drag, edit, create)                                         │
│       │                                                                    │
│       ▼                                                                    │
│   Optimistic UI update (instant visual feedback)                           │
│       │                                                                    │
│       ├── REST call: POST/PUT/DELETE /api/tasks/...                         │
│       │       │                                                            │
│       │       ▼                                                            │
│       │   Server writes to SQL Server (single transaction)                 │
│       │       │                                                            │
│       │       ├── On success: WebSocket broadcast to ALL clients           │
│       │       │   (other tabs/browsers see the change instantly)           │
│       │       │                                                            │
│       │       └── On failure: WebSocket error → UI rolls back              │
│       │                                                                    │
│       └── If WebSocket confirms: UI stays as-is (already updated)          │
│           If WebSocket rejects: UI reverts to previous state               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   DB → BROWSER (change detection + push)                                   │
│                                                                            │
│   External write to DB (agent session, direct SQL, another service)        │
│       │                                                                    │
│       ▼                                                                    │
│   Server-side change detector (polling or Change Tracking)                 │
│       │                                                                    │
│       ▼                                                                    │
│   Detect new/modified/deleted rows (compare updated_at or CT version)      │
│       │                                                                    │
│       ▼                                                                    │
│   WebSocket broadcast: { type: "task-created/updated/deleted", ... }       │
│       │                                                                    │
│       ▼                                                                    │
│   Browser receives → updates in-memory state → re-renders board view       │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Strategy: Optimistic UI + Server-Authoritative State

| Direction | Mechanism | Latency |
|-----------|-----------|---------|
| Browser → DB | REST call (write-through) + optimistic UI | < 50ms perceived (UI updates before response) |
| DB → Browser | Server polls DB every 1-2s OR uses SQL Server Change Tracking + WebSocket push | < 2s for external changes |
| Browser ↔ Browser | WebSocket broadcast after every successful DB write | < 100ms (same-server clients) |

#### Implementation Details

**1. Browser → DB (User actions)**

```typescript
// Client-side: optimistic update pattern
async function moveTask(taskId: number, newState: string) {
  // 1. Optimistic: update UI immediately
  updateLocalState(taskId, { state: newState });
  renderBoard();

  // 2. Persist to DB via REST
  const res = await fetch(`/api/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ state: newState })
  });

  if (!res.ok) {
    // 3. Rollback on failure
    revertLocalState(taskId);
    renderBoard();
    showError('Failed to update task');
  }
  // On success: WebSocket broadcast will confirm to other clients
}
```

**2. DB → Browser (External changes)**

The server detects external DB changes and pushes them to all connected WebSocket clients. Two approaches (choose one):

**Option A: Polling with `updated_at` watermark (simpler, works everywhere)**

```typescript
// Server-side: poll every 1-2 seconds
let lastPollTime = new Date().toISOString();

setInterval(async () => {
  const changed = await db.query(`
    SELECT * FROM tasks
    WHERE updated_at > @lastPollTime
  `, { lastPollTime });

  if (changed.length > 0) {
    for (const task of changed) {
      broadcast({ type: 'task-updated', task });
    }
    lastPollTime = new Date().toISOString();
  }
}, 1500); // 1.5s interval
```

**Option B: SQL Server Change Tracking (lower latency, built-in)**

```sql
-- Enable Change Tracking on the database
ALTER DATABASE kirofactory
SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);

-- Enable on each table
ALTER TABLE tasks ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
ALTER TABLE boards ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
ALTER TABLE task_boards ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
```

```typescript
// Server-side: query changes since last known version
let lastVersion = await db.query('SELECT CHANGE_TRACKING_CURRENT_VERSION()');

setInterval(async () => {
  const changes = await db.query(`
    SELECT ct.SYS_CHANGE_OPERATION, ct.id, t.*
    FROM CHANGETABLE(CHANGES tasks, @lastVersion) AS ct
    LEFT JOIN tasks t ON ct.id = t.id
  `, { lastVersion });

  for (const change of changes) {
    switch (change.SYS_CHANGE_OPERATION) {
      case 'I': broadcast({ type: 'task-created', task: change }); break;
      case 'U': broadcast({ type: 'task-updated', task: change }); break;
      case 'D': broadcast({ type: 'task-deleted', taskId: change.id }); break;
    }
  }

  lastVersion = await db.query('SELECT CHANGE_TRACKING_CURRENT_VERSION()');
}, 1000); // 1s interval
```

**3. Browser receives WebSocket updates**

```typescript
// Client-side: handle incoming changes
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'task-created':
      addToLocalState(msg.task);
      renderBoard();
      break;
    case 'task-updated':
      updateLocalState(msg.task.id, msg.task);
      renderBoard();
      break;
    case 'task-deleted':
      removeFromLocalState(msg.taskId);
      renderBoard();
      break;
    case 'board-updated':
      updateBoardState(msg.board);
      renderBoardSelector();
      break;
  }
};
```

#### Conflict Resolution

When multiple clients (or an agent + a human) modify the same task simultaneously:

| Scenario | Resolution |
|----------|-----------|
| Two users edit different fields of same task | Last-write-wins (both writes succeed, `updated_at` determines final state) |
| Two users edit same field | Last-write-wins + server broadcasts final state to both clients |
| User edits a task that was just deleted | REST returns 404 → UI removes the task card |
| Agent creates task while user is viewing board | WebSocket push → new card appears on board instantly |

#### Deduplication

The browser must avoid double-rendering when it performs an action (optimistic update) and then receives the same change via WebSocket broadcast:

```typescript
// Client-side: track pending operations
const pendingOps = new Set<string>(); // "task:5:state" format

function moveTask(taskId, newState) {
  const opKey = `task:${taskId}:state`;
  pendingOps.add(opKey);
  updateLocalState(taskId, { state: newState });
  // ... REST call ...
  // On WebSocket confirm: pendingOps.delete(opKey)
}

// In WebSocket handler:
if (pendingOps.has(opKey)) {
  pendingOps.delete(opKey); // Already applied locally, skip re-render
  return;
}
```

#### Guarantees

| Guarantee | How |
|-----------|-----|
| No stale data on screen | WebSocket push + periodic reconciliation (full board refresh every 30s as safety net) |
| No lost writes | Every UI action hits the DB synchronously via REST before being considered "done" |
| Multi-tab consistency | WebSocket broadcast ensures all open tabs see the same state |
| External change visibility | Server polls DB for changes not originated from itself (agent writes, direct SQL) |
| Graceful degradation | If WebSocket disconnects, UI falls back to polling REST every 3s until reconnected |

### 3.7 Key Features

| Feature | Description |
|---------|-------------|
| **Sessions** | |
| Session Creation | Configure agent, prompt, working directory, timeout, MCP servers |
| Real-time Streaming | WebSocket pushes stdout/stderr line-by-line to all connected tabs |
| Multi-session | Run multiple ACP sessions concurrently, each in its own subprocess |
| Follow-up Prompts | Send additional prompts to an active session (multi-turn conversation) |
| Activity Tracking | Parse streaming output to show what the agent is currently doing |
| Templates | Save and reuse session configurations (agent + prompt + settings) |
| Output History | Keep last N lines per session, request full history on connect |
| Graceful Stop | Cancel ACP session, kill subprocess tree, report exit code |
| Error Handling | Log crashes/timeouts, surface errors in the UI |
| Multi-client Sync | Multiple browser tabs see the same state via WebSocket broadcast |
| Persistence | Session configs stored in sessions.json, survive server restart |
| **Tasks & Boards** | |
| Task CRUD | Create, read, update, delete tasks in SQL Server |
| Board Management | Create/rename/delete boards, each with its own task view |
| Kanban Board View | Visual column-based view grouped by state |
| Drag-and-drop | Change task state by dragging between columns |
| Multi-board membership | Tasks can belong to multiple boards (many-to-many) |
| Priority system | 4-level priority with color coding and sorting |
| Origin tracking | Track whether task was created by user, AI, or AI-assisted |
| Filtered views | Filter/sort tasks by state, priority, type, origin |
| Agent integration | Running sessions can create/update tasks via the API |
| **Real-time Sync** | |
| Optimistic UI | User actions reflected instantly, rolled back on failure |
| Write-through | Every UI change persists to SQL Server before confirmation |
| WebSocket broadcast | All connected clients see changes within ~100ms |
| DB change detection | External writes (agents, direct SQL) detected via polling/Change Tracking |
| Deduplication | Pending ops tracked to avoid double-render on self-originated changes |
| Reconnect fallback | On WebSocket drop, UI polls REST every 3s until reconnected |

### 3.8 Differences from TecFactory

| Aspect | TecFactory | KiroFactory |
|--------|-----------|-------------|
| Focus | Autonomous agent loops (continuous iteration) | On-demand ACP sessions + task management |
| Task System | File-based JSON tasks with priority naming | SQL Server with boards (many-to-many) |
| Task UI | Simple list/filter | Kanban board view with drag-and-drop |
| Git Integration | Auto-commit/push after each dev iteration | Not included (user handles git) |
| Agent Types | Hardcoded types (dev, qa, task-order) | Generic — any agent, any prompt |
| Prompt Model | Built-in prompts per type | User-provided prompts per session |
| Concurrency | Lock-file-based task claiming for parallelism | DB-level task claiming (row locking) |
| Persistence | JSON files on disk | SQL Server (tasks/boards) + JSON (sessions) |
| Frontend | Vanilla HTML/JS | Vanilla HTML/CSS/JS (no build step) |

---

## 4. Implementation Plan

### Phase 1 — Core Server + ACP Integration

- [ ] Project scaffold (Node.js, Express, ws, TypeScript)
- [ ] Port KiroRunner from TecFactory (ACP client wrapper)
- [ ] Session CRUD REST API
- [ ] Process manager (spawn/stop kiro-cli acp per session)
- [ ] WebSocket server with broadcast

### Phase 2 — Database + Tasks/Boards API + Real-time Sync

- [ ] SQL Server connection setup (mssql / tedious driver)
- [ ] Run schema migration (boards, tasks, task_boards tables)
- [ ] Enable Change Tracking on tables (or implement `updated_at` polling)
- [ ] Tasks REST API (CRUD with filtering/sorting)
- [ ] Boards REST API (CRUD with task membership)
- [ ] Task ↔ Board assignment endpoints
- [ ] WebSocket broadcast on every successful DB write
- [ ] DB change detector (poll interval or Change Tracking query loop)
- [ ] Broadcast externally-originated changes to all WebSocket clients

### Phase 3 — Browser UI: Board View

- [ ] Board selector / board management UI
- [ ] Kanban column layout (Todo | In Progress | Developed)
- [ ] Task cards with priority/type/origin badges
- [ ] Task creation form (with board assignment)
- [ ] Task editing panel (inline or modal)
- [ ] Drag-and-drop state changes (optimistic UI + REST write-through)
- [ ] WebSocket client: handle task-created/updated/deleted messages
- [ ] Deduplication logic (pending ops tracking)
- [ ] Reconnect fallback (poll REST on WebSocket disconnect)
- [ ] Periodic reconciliation (full board refresh every 30s as safety net)
- [ ] Filtering and sorting controls

### Phase 4 — Browser UI: Sessions

- [ ] Session list view (status, name, agent, activity)
- [ ] Session creation form (agent, prompt, cwd, timeout, MCP servers)
- [ ] Real-time log viewer per session
- [ ] Start/Stop controls
- [ ] Follow-up prompt input for active sessions
- [ ] Connection status indicator

### Phase 5 — Integration & Polish

- [ ] Agent sessions can create/update tasks via API
- [ ] Session templates (save/load configurations)
- [ ] Error boundary / crash recovery
- [ ] Dark mode
- [ ] Keyboard shortcuts
- [ ] Notifications (session complete, task state change)
- [ ] Unit tests (Vitest + supertest)

---

## 5. Technical Requirements

### Prerequisites

| Requirement | Why |
|-------------|-----|
| `kiro-cli` installed and authenticated | Subprocess spawns kiro-cli for ACP |
| Node.js 20+ | ES modules, modern APIs |
| `@agentclientprotocol/sdk` | ACP protocol handling |
| `.kiro/agents/` folder with agent definitions | kiro-cli needs agent configs |
| SQL Server instance (local or remote) | Persistent storage for tasks and boards |

### Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.x",
    "ws": "^8.16.x",
    "@agentclientprotocol/sdk": "^0.19.0",
    "mssql": "^11.x"
  },
  "devDependencies": {
    "typescript": "~5.7.x",
    "@types/node": "^22.x",
    "vitest": "^3.x",
    "supertest": "^7.x"
  }
}
```

### Environment Variables

```env
# SQL Server connection
DB_SERVER=localhost
DB_DATABASE=kirofactory
DB_USER=sa
DB_PASSWORD=<your-password>
DB_PORT=1433
DB_ENCRYPT=false
DB_TRUST_SERVER_CERTIFICATE=true

# Server
PORT=3500
```

### File Structure

```
kirofactory/
├── src/
│   ├── server.ts              # Express + WebSocket server, route registration
│   ├── kiro-runner.ts         # ACP client (spawn kiro-cli acp)
│   ├── session-manager.ts     # Session lifecycle (create/start/stop/delete)
│   ├── websocket-handler.ts   # WebSocket message routing + broadcast
│   ├── db/
│   │   ├── connection.ts      # mssql connection pool setup
│   │   ├── migrate.ts         # Schema creation/migration script
│   │   ├── tasks.ts           # Task CRUD queries
│   │   └── boards.ts          # Board CRUD queries
│   ├── routes/
│   │   ├── sessions.ts        # /api/sessions routes
│   │   ├── tasks.ts           # /api/tasks routes
│   │   └── boards.ts          # /api/boards routes
│   └── types.ts               # Shared TypeScript interfaces
├── public/
│   ├── index.html             # Dashboard UI (tabs: Boards | Sessions)
│   ├── style.css              # Styles (dark mode support)
│   └── app.js                 # Client-side logic + WebSocket + board view
├── sql/
│   └── schema.sql             # Database schema (boards, tasks, task_boards)
├── sessions.json              # Persisted session configs (file-based)
├── templates.json             # Saved session templates
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 6. ACP Protocol Flow (How it Works Under the Hood)

```
KiroFactory Server                kiro-cli acp              Kiro Cloud
       │                               │                        │
       │── spawn("kiro-cli acp") ─────►│                        │
       │                               │── ACP initialize ─────►│
       │◄── NDJSON (stdout) ───────────│◄── ACP response ──────│
       │                               │                        │
       │── NDJSON: newSession ────────►│── create session ─────►│
       │◄── NDJSON: { sessionId } ─────│◄── session created ───│
       │                               │                        │
       │── NDJSON: prompt(text) ──────►│── forward prompt ─────►│
       │◄── NDJSON: sessionUpdate ─────│◄── stream chunks ─────│
       │◄── NDJSON: sessionUpdate ─────│◄── tool_call ─────────│
       │◄── NDJSON: sessionUpdate ─────│◄── agent_message ─────│
       │   ... (streaming) ...         │                        │
       │◄── NDJSON: prompt resolved ───│◄── turn complete ─────│
       │                               │                        │
       │── NDJSON: cancel(session) ───►│── cancel ─────────────►│
       │── kill process ──────────────►│                        │
       │                               ✕                        │
```

Key protocol details:
- Communication is **NDJSON over stdio** (newline-delimited JSON)
- The `@agentclientprotocol/sdk` handles serialization/deserialization
- `_kiro.dev/session/update` notifications carry streaming content (agent text, tool calls)
- Tool permission requests are auto-approved for autonomous operation
- Session is cancelled before subprocess is killed for clean shutdown

---

## 7. Decisions Made & Open Questions

### Resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Frontend framework | **Vanilla HTML/CSS/JS** — no build step for frontend, same pattern as TecFactory |
| 2 | Database | **SQL Server** — schema provided (boards, tasks, task_boards with Change Tracking) |
| 3 | Port | **3500** (default) |
| 4 | kiro-cli | Available and authenticated on the machine |
| 5 | Task persistence | **SQL Server** (not file-based like TecFactory) |
| 6 | Real-time sync | **Optimistic UI + WebSocket broadcast + DB change polling** (fully specified in 3.6) |
| 7 | Auth identity for Azure DevOps | **Service account** — single PAT, all actions as bot user. Per-user PAT injection planned for later. See [ADR-001](./docs/adr/001-service-account-identity-for-azure-devops.md) |

### Still Open

1. **SQL Server connection** — Host, database name, auth method (Windows auth / SQL auth with credentials)?
2. **Multi-workspace** — Should one KiroFactory server manage sessions across multiple project directories?
3. **Authentication** — Should the dashboard require auth, or is local-only access sufficient?
4. **Session persistence** — Keep output logs on disk or only in-memory with a max buffer?
5. **Task claiming** — When an agent session picks a task, DB row locking or optimistic concurrency?
6. **Session → Task link** — Should sessions track which task they're working on (FK)?
7. **Board permissions** — Access control per board, or all boards visible to everyone?
8. **Task history** — Log state changes in an audit table?

---

## 8. Reference Implementation

The full TecFactory source is available at:
- **Server:** [`tecfactory/server.js`](https://github.com/RobinMohr/ValueModeller/blob/develop/tecfactory/server.js)
- **ACP Client:** [`scripts/src/kiro-runner.ts`](https://github.com/RobinMohr/ValueModeller/blob/develop/scripts/src/kiro-runner.ts)
- **Agent Loop:** [`scripts/src/agent-loop.ts`](https://github.com/RobinMohr/ValueModeller/blob/develop/scripts/src/agent-loop.ts)
- **Frontend:** [`tecfactory/public/index.html`](https://github.com/RobinMohr/ValueModeller/blob/develop/tecfactory/public/index.html)
