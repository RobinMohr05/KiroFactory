# KiroFactory

A web-based manager for creating, running, and monitoring **Kiro ACP sessions** from a browser dashboard, with a **Kanban board** for task management backed by SQL Server.

## Architecture

```
Browser (vanilla HTML/CSS/JS)
    │ HTTP + WebSocket (port 3500)
    ▼
Express + WebSocket Server (Node.js / TypeScript)
    │
    ├── REST API: /api/tasks, /api/boards
    ├── WebSocket: real-time task/board updates
    ├── DB change detector (poll loop)
    │
    ▼
SQL Server (boards, tasks, task_boards)
```

## Features

- **Kanban Board** — Drag-and-drop task cards between Todo / In Progress / Developed columns
- **Multi-board support** — Tasks can belong to multiple boards (many-to-many)
- **Real-time sync** — Optimistic UI + WebSocket broadcast + DB change polling
- **Priority system** — P1 (Critical) through P4 (Low) with color-coded cards
- **Task types** — Improvement, Problem, Idea with badge indicators
- **Origin tracking** — User, AI, or User-Assisted
- **Dark mode** — Built-in dark theme
- **Responsive** — Works on mobile and desktop

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20+ |
| SQL Server | Any (Azure SQL or local) |

## Setup

1. **Install dependencies:**

```bash
npm install
cd server && npm install
```

2. **Configure environment:**

```bash
cp server/.env.example server/.env
# Edit server/.env with your SQL Server connection details
```

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_SERVER` | SQL Server host | `localhost` |
| `DB_DATABASE` | Database name | `TecFactory` |
| `DB_USER` | SQL auth username | `sa` |
| `DB_PASSWORD` | SQL auth password | — |
| `DB_PORT` | SQL Server port | `1433` |
| `DB_ENCRYPT` | Use encrypted connection | `false` |
| `DB_TRUST_SERVER_CERTIFICATE` | Trust self-signed certs | `true` |
| `PORT` | HTTP server port | `3500` |

3. **Run database migration** (auto-runs on server start, or manually):

```bash
cd server && npm run migrate
```

4. **Start the server:**

```bash
cd server && npm run dev
```

5. **Open the dashboard:**

Navigate to `http://localhost:3500`

## Project Structure

```
kirofactory/
├── public/
│   ├── index.html          # Dashboard UI (Boards | Sessions tabs)
│   ├── style.css           # Dark mode styles, Kanban layout
│   └── app.js              # Client-side logic + WebSocket + drag-and-drop
├── server/
│   ├── src/
│   │   ├── index.ts        # Express + WebSocket server + DB poll loop
│   │   ├── types.ts        # Shared TypeScript interfaces
│   │   ├── websocket-handler.ts  # WebSocket broadcast
│   │   ├── db/
│   │   │   ├── connection.ts     # mssql connection pool
│   │   │   ├── migrate.ts        # Auto-create tables on startup
│   │   │   ├── tasks.ts          # Task CRUD queries
│   │   │   └── boards.ts         # Board CRUD queries
│   │   └── routes/
│   │       ├── tasks.ts          # /api/tasks REST endpoints
│   │       └── boards.ts         # /api/boards REST endpoints
│   ├── sql/
│   │   └── schema.sql      # Database schema (reference)
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── package.json             # Workspace root
├── SPEC.md                  # Full system specification
└── TASKS.md                 # Implementation task breakdown
```

## API

### Boards

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/boards` | List all boards |
| POST | `/api/boards` | Create board `{ name }` |
| GET | `/api/boards/:id` | Get board with its tasks |
| PUT | `/api/boards/:id` | Rename board `{ name }` |
| DELETE | `/api/boards/:id` | Delete board |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List tasks (filter: `?state=&priority=&boardId=`) |
| POST | `/api/tasks` | Create task `{ title, priority, type, ... }` |
| GET | `/api/tasks/:id` | Get single task with boards |
| PUT | `/api/tasks/:id` | Update task fields |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/boards` | Assign to boards `{ boardIds[] }` |
| DELETE | `/api/tasks/:id/boards/:boardId` | Remove from board |

### WebSocket

Connect to `ws://localhost:3500`. Messages are broadcast on every DB write:

```json
{ "type": "task-created", "task": { ... } }
{ "type": "task-updated", "task": { ... } }
{ "type": "task-deleted", "taskId": 5 }
{ "type": "board-created", "board": { ... } }
{ "type": "board-updated", "board": { ... } }
{ "type": "board-deleted", "boardId": 2 }
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` (in `server/`) | Start dev server with hot reload (tsx watch) |
| `npm run build` (in `server/`) | Compile TypeScript to `dist/` |
| `npm run start` (in `server/`) | Run compiled server |
| `npm run migrate` (in `server/`) | Run DB migration manually |

## Roadmap

See [TASKS.md](./TASKS.md) for the full implementation plan. Current status:

- [x] Phase 1 — Core Server (Express + WebSocket)
- [x] Phase 2 — Database + Tasks/Boards API + Real-time Sync
- [x] Phase 3 — Browser UI: Board View (Kanban + drag-and-drop)
- [ ] Phase 4 — Browser UI: Sessions (ACP session management)
- [ ] Phase 5 — Integration & Polish
