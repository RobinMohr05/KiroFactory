# KiroFactory Backend (Orchestrator)

The backend is the KiroFactory **orchestrator**: an Express REST API + WebSocket server that
manages tasks, tabs, sessions, users, and triggers Kiro worker jobs. It also serves the static
frontend.

> For the big picture (Azure resources, deploy commands, logs), see the root
> [`ARCHITECTURE.md`](../ARCHITECTURE.md). This file focuses on the backend internals.

---

## Stack

- Node 20, TypeScript (ESM, `"type": "module"`)
- Express 4 (REST) + `ws` (WebSocket)
- `neo4j-driver` → Neo4j AuraDB Free
- `bcrypt` (password hashing), `jsonwebtoken` (auth), AES-256-GCM (`crypto.ts`) for secrets
- `@azure/identity` for managed-identity auth to the ACA Jobs API

## Scripts

```bash
npm run dev          # tsx watch — local dev server
npm run build        # tsc → dist/
npm start            # node dist/index.js (production)
npm run migrate      # run DB migration (src/db/migrate.ts)
npm test             # vitest
```

Runs as part of the npm workspaces monorepo; the lockfile lives at the repo root.

---

## Source layout (`src/`)

| File / dir | Responsibility |
|------------|----------------|
| `index.ts` | Entry point. Sets up Express, CORS, static serving, routes, WebSocket, DB connect, change-detector poll loop, graceful shutdown. |
| `session-manager.ts` | Core of the app. Manages the in-memory session store, starts/stops sessions, and switches between **local** mode (spawn `kiro-cli`) and **remote** mode (ACA Jobs). |
| `aca-worker-spawner.ts` | Builds ACA Job execution requests and calls the Azure REST API. `loadAcaConfig()` reads all `ACA_*` env vars — returns null if any required one is missing. |
| `worker-ws-handler.ts` | The `/internal/worker` WebSocket endpoint. Authenticates workers (shared secret) and relays prompts/output between orchestrator and worker. |
| `websocket-handler.ts` | The client-facing `/ws` WebSocket. JWT-cookie auth, broadcasts task/session updates to browsers. |
| `mcp-proxy-config.ts` | Builds the per-session MCP `servers.json` from tab config + session overrides + decrypted credentials. |
| `crypto.ts` | AES-256-GCM encrypt/decrypt using `ENCRYPTION_KEY`. Used for all stored secrets. |
| `logger.ts` | Structured JSON logging (session/worker events) for Azure Monitor. |
| `error-store.ts` | In-memory ring buffer of agent errors surfaced in the UI Errors tab. |
| `types.ts` | Shared TypeScript types (Session, Task, Tab, credentials, WS messages). |
| `agent/` | Kiro agent integration (see below). |
| `db/` | Data-access layer (see below). |
| `routes/` | REST route handlers (see below). |
| `middleware/` | `auth.ts` (JWT guard, public-path list) and `error-logger.ts`. |

### `agent/`
| File | Responsibility |
|------|----------------|
| `kiro-runner.ts` | Wraps `kiro-cli acp` as a subprocess over the Agent Client Protocol (NDJSON/stdio). Used in **local** worker mode. |
| `task-claimer.ts` | Atomically claims a task from the DB for a loop session; resolves/resets through the multi-stage pipeline; resets orphaned tasks. |
| `prompt-builder.ts` | Builds the per-turn prompt sent to the agent for a claimed task (editor vs. inspector). |
| `index.ts` | Agent module exports. |

There is no standalone CLI agent runner in this directory — task execution always goes through
`session-manager.ts` (local child process or ACA worker job). See
[`.kiro/steering/developer-agent-task-lifecycle.md`](../.kiro/steering/developer-agent-task-lifecycle.md)
for the full pipeline.

### `db/`
| File | Responsibility |
|------|----------------|
| `connection.ts` | Neo4j `Driver` lifecycle: `tryConnect` (retry-then-give-up, never throws), `isDbAvailable()` (cheap sync flag), `getDriver()` (throw-if-unavailable), `closePool()`, plus the `readQuery`/`writeQuery` managed-transaction helpers and `runSchemaStatement` used by `migrate.ts`. No connection-pool stats API (no `neo4j-driver` equivalent to `mssql`'s pool introspection — see `ARCHITECTURE.md` §9 and the design doc's "known gap" note). |
| `migrate.ts` | Applies the Neo4j constraint/index bootstrap on startup (replaces the old 26-step incremental SQL `ALTER`-based runner) — idempotent, safe to run every time. |
| `id-counter.ts` | `getNextId(label)` / `ensureCounterAtLeast(label, min)` — atomic per-label ID allocation via `:Counter` nodes, replacing SQL `IDENTITY` columns. |
| `users.ts` | User CRUD; encrypts Kiro API key; never returns secrets. |
| `credentials.ts` | Per-user encrypted credential storage; `getAllDecryptedCredentials` used only when spawning workers. |
| `tasks.ts` | Task CRUD + `getChangedTasksSince` (drives the change detector), plus `DEPENDS_ON` writes (cycle-checked) and `isBlocked`/`blockedBy` computation. **When the user says "tasks/items", they mean this table.** |
| `tabs.ts` | Tab (board) CRUD + MCP config + repository URL. |
| `sessions.ts` | Session persistence. |

### `routes/`
`auth`, `tasks`, `tabs`, `sessions`, `agents`, `errors`, `credentials`, `admin`.
All under `/api/*`. The global auth guard in `index.ts` protects everything except the public
paths listed in `middleware/auth.ts` (health, login, register, static assets).

---

## Worker modes

`session-manager.ts` decides at module load:
- `WORKER_MODE=local` → spawn `kiro-cli` as a child process (developer machine).
- `WORKER_MODE=remote` → call the ACA Jobs API; the worker container connects back over
  `/internal/worker`. This is production.
- If `WORKER_MODE` is unset, it auto-detects: remote if `loadAcaConfig()` returns non-null,
  else local.

For remote mode to activate, **all** required `ACA_*` env vars must be present (see
`ARCHITECTURE.md` §5). The most common miss is `ACA_WORKER_IMAGE`.

---

## Database

Neo4j AuraDB Free, reached over the public Bolt protocol (`neo4j+s://...`). Connection details
come from `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD`/`NEO4J_DATABASE` (see `.env.example`).
The constraint/index bootstrap in `migrate.ts` runs automatically and idempotently on every
startup — no separate manual migration step. The server tolerates a missing DB at boot (the UI
loads, task features return 503 until the DB is reachable).

No firewall/IP-whitelisting to manage — AuraDB's Bolt endpoint is public, secured by
username/password rather than network allow-listing. The one operational quirk worth knowing:
AuraDB Free auto-pauses after 72h of inactivity and takes a moment to resume on the next
connection (`connection.ts` uses a 60s `connectionTimeout` to accommodate this).

---

## Local development

### Quick start (using the shared AuraDB instance)

```bash
# from repo root
npm install
# create backend/.env (see backend/.env.example) with NEO4J_* and ENCRYPTION_KEY
npm run dev -w backend
```

`.env` keys of note: `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD`/`NEO4J_DATABASE`,
`ENCRYPTION_KEY` (must match whatever encrypted the stored data), `WORKER_MODE=local` for local
agent runs.

---

### Run entirely on localhost (no Azure, no Docker)

You can run the full application on localhost with no Docker and no direct Azure access. There's
no local database engine to install anymore — everyone (production and every developer) connects
to the **same shared Neo4j AuraDB Free instance**. This is an explicitly accepted tradeoff, not
an oversight (Requirement 7.2 of the Neo4j migration spec): there's no per-developer data
isolation, so a task you create or edit locally is visible to everyone else pointed at the same
instance, and vice versa.

> See also: the root [`ARCHITECTURE.md`](../ARCHITECTURE.md) §11 for a short summary of this flow.

#### Prerequisites

- **Node.js 20+**
- Shared AuraDB credentials — ask a teammate, or check the team's credential store. Don't put
  the actual password in a doc; you just need the variable names, which are in
  `backend/.env.example`: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.

#### Step-by-step

```bash
# 1. Install dependencies (from repo root)
npm install

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env:
#   - fill in NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD / NEO4J_DATABASE
#     (obtained from a teammate or the team's credential store)
#   - generate and set ENCRYPTION_KEY:
#       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start the server
npm run dev -w backend
```

There's no separate migration step to run by hand — the constraint/index bootstrap
(`src/db/migrate.ts`'s `runMigration()`) runs automatically and idempotently every time the
server starts.

Open <http://localhost:3500> and log in with an existing account, or register a new one.

> **`npm run seed:local -w backend` is currently broken** — it still imports the old, removed
> `getPool`/`sql` mssql API from `connection.js` and will fail immediately. This is a known,
> separate gap; it hasn't been rewritten for Neo4j yet. The `local-dev@example.com` /
> `localdev123` test account it used to create doesn't exist until that script is rewritten.

#### What works without `kiro-cli`

The following features work fully **without** `kiro-cli` installed:

- ✅ Login / registration / user management
- ✅ Task CRUD (create, edit, delete, drag between columns)
- ✅ Tab/board management (create, rename, reorder, configure)
- ✅ Real-time WebSocket sync across browser tabs
- ✅ The entire Kanban UI, filters, and search

The **only** feature that requires `kiro-cli` on PATH is **starting an actual agent session**
(the "Start" button on a session). If `kiro-cli` is not installed, attempting to start a
session will show a clear error in the Errors tab:

> "kiro-cli not found on PATH — install it from https://cli.kiro.dev/install or skip agent
> sessions. Task/board management works without it."

Install `kiro-cli` from <https://cli.kiro.dev/install> only when you need to run agent sessions.

#### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/api/health` shows `database: unavailable` | Double-check `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` against the credential store; if the instance has been idle, AuraDB Free auto-pauses after 72h and needs a moment to resume on the next connection. |
| `ENCRYPTION_KEY` error on startup | Generate and set a 64-char hex key (see step 2 above). |

---

## Deploy

See root `ARCHITECTURE.md` §6. Short version, from repo root:

```bash
az acr build --registry kiroFactory --image kirofactory-api:latest --file Dockerfile .
az containerapp update --name kirofactory-api --image kirofactory.azurecr.io/kirofactory-api:latest
```
