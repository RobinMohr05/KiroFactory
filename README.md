# KiroFactory

A web-based orchestration platform for running autonomous **Kiro CLI agent sessions** against
Git repositories. It presents a Kanban-style board where tasks can be picked up by an AI agent
that clones a repo, does the work, and opens a pull request.

For the full picture (Azure resources, deploy commands, data model, troubleshooting), see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) — this file is a shorter, getting-started-focused summary.

## Architecture

```
Browser (vanilla HTML/CSS/JS)
    │ HTTP + WebSocket (port 3500)
    ▼
Express + WebSocket Server (backend/, Node.js / TypeScript)
    │
    ├── REST API: /api/tasks, /api/tabs, /api/sessions, /api/agents, ...
    ├── WebSocket: real-time task/tab/session updates
    │
    ├── Neo4j AuraDB Free (Bolt, neo4j+s://)
    │
    └── triggers ──> worker/ (Azure Container Apps Job, 1 per session)
                          │
                          ├── kiro-cli acp (the agent)
                          └── git clone / commit / push / PR
```

See `ARCHITECTURE.md` §3 for the full breakdown of the three deployable pieces
(backend/frontend/worker).

## Features

- **Kanban board** — Drag-and-drop task cards between Todo / In Progress / Developed columns
- **Multi-tab support** — Tasks belong to one or more tabs (projects/boards), each mapped to a repository
- **Task dependencies** — A task can depend on other tasks; it's marked "blocked" (visually
  distinct, non-claimable by agents) until all its dependencies reach the done state, editable
  via an in-card dependency picker
- **Real-time sync** — WebSocket broadcast on every change, with a polling fallback
- **Priority system** — P1 (Critical) through P4 (Low) with color-coded cards
- **Task types** — Bug, Feature, Improvement with badge indicators
- **Origin tracking** — User, AI, or User-Assisted
- **Dark mode** — Built-in dark theme
- **Responsive** — Works on mobile and desktop

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20+ |
| Neo4j | AuraDB Free, or self-hosted Neo4j |

## Setup

```bash
# 1. Install dependencies (npm workspaces monorepo — one install at the root)
npm install

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env: fill in NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD / NEO4J_DATABASE
# and generate an ENCRYPTION_KEY:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start the backend (serves the frontend too, same origin)
npm run dev -w backend
```

Open `http://localhost:3500`.

The full variable list and local-development details (including the shared-AuraDB-instance
tradeoff for local dev) live in [`backend/.env.example`](./backend/.env.example),
[`backend/README.md`](./backend/README.md), and `ARCHITECTURE.md` §5/§11 — see those instead of
duplicating a variable table here.

## Project Structure

```
KiroFactory/
├── ARCHITECTURE.md            ← top-level architecture & operations guide
├── Dockerfile                 ← builds the backend+frontend image (kirofactory-api)
├── package.json               ← npm workspaces root (backend + frontend)
├── package-lock.json          ← single lockfile for the whole monorepo
├── SPEC.md                    ← original project spec (historical, not kept current)
│
├── backend/                   ← the orchestrator (Express + WebSocket + Neo4j)
│   ├── README.md              ← backend-specific guide
│   └── src/                   ← TypeScript source
│
├── frontend/                  ← the static web UI
│   ├── README.md              ← frontend-specific guide
│   └── public/                ← HTML/CSS/JS served by the backend
│
├── worker/                    ← the Kiro session worker (ACA Job image)
│   ├── Dockerfile             ← builds kirofactory-worker image
│   └── worker.js              ← worker agent script
│
└── infra/                     ← Bicep + shell scripts for Azure deployment
```

## API

All routes are under `/api/*` and JWT-protected (cookie `kf_session`) except health/login/register.
Full detail lives in the route files themselves and `backend/README.md`'s routes bullet — this is
a summary:

| Router | Base path | Notes |
|--------|-----------|-------|
| `tasks` | `/api/tasks` | `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, plus `POST /:id/tabs` and `DELETE /:id/tabs/:tabId` to manage tab assignment. |
| `tabs` | `/api/tabs` | `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `PUT /reorder`. |
| `sessions` | `/api/sessions` | Create/start/stop/reorder Kiro agent sessions. |
| `agents` | `/api/agents` | Manage agent definitions (prompt, tools, pipeline stage). |
| `auth` | `/api/auth` | Login/register/session. |
| `credentials` | `/api/users/me/credentials` | Per-user encrypted service credentials (write-only from the browser's perspective). |
| `errors` | `/api/errors` | Agent errors surfaced in the UI Errors tab. |
| `admin` | `/api/admin` | Admin-only operations. |

### WebSocket

Connect to `wss://<host>/ws` (JWT cookie auth). Messages are broadcast on every relevant DB write,
e.g.:

```json
{ "type": "task-created", "task": { ... } }
{ "type": "task-updated", "task": { ... } }
{ "type": "task-deleted", "taskId": 5 }
{ "type": "tab-created", "tab": { ... } }
{ "type": "tab-updated", "tab": { ... } }
{ "type": "tab-deleted", "tabId": 2 }
```

See `backend/src/types.ts`'s `WsServerMessage` union for the complete list (also includes
`agent-*`, `session-*`, and `error-*` events).

## Scripts

```bash
npm run dev      # from repo root: runs backend + frontend dev servers together (concurrently)
npm run build    # from repo root: builds backend + frontend
npm start         # from repo root: starts the built backend

npm run dev -w backend     # backend dev server only (tsx watch)
npm run build -w backend   # backend build only (tsc -> dist/)
npm test -w backend        # backend test suite (vitest)
```

See `backend/package.json` for the full script list (migration, agent/local seeding, etc.).

## Roadmap

There's no `TASKS.md` in this repo anymore — treat `.kiro/specs/` for active, in-progress specs
and `ARCHITECTURE.md` for the current state of the system instead of a standalone roadmap file.
