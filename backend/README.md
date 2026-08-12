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
- `mssql` driver → Azure SQL (`TecFactory`)
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
| `logger.ts` | Structured JSON logging (session/worker events, pool metrics) for Azure Monitor. |
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
| `task-claimer.ts` | Atomically claims a task from the DB for a loop session; resets orphaned tasks. |
| `prompt-builder.ts` | Builds the developer prompt sent to the agent for a claimed task. |
| `dev-agent.ts` | CLI entry point for running an agent loop locally (dev tooling). |
| `index.ts` | Agent module exports. |

### `db/`
| File | Responsibility |
|------|----------------|
| `connection.ts` | Connection pool, `tryConnect`, availability flag, pool stats. |
| `migrate.ts` | Applies `sql/schema.sql` on startup. |
| `users.ts` | User CRUD; encrypts Kiro API key; never returns secrets. |
| `credentials.ts` | Per-user encrypted credential storage; `getAllDecryptedCredentials` used only when spawning workers. |
| `tasks.ts` | Task CRUD + `getChangedTasksSince` (drives the change detector). **When the user says "tasks/items", they mean this table.** |
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

Azure SQL `TecFactory` on `REDACTED_DB_SERVER`. Schema in `sql/schema.sql`;
applied automatically by `migrate.ts` on startup. The server tolerates a missing DB at boot
(the UI loads, task features return 503 until the DB is reachable).

Firewall: the ACA environment's outbound IPs must be allowed on the SQL server, or enable
"Allow Azure services". A local dev machine needs its own IP added to query the DB directly.

---

## Local development

### Quick start (using the shared Azure SQL database)

```bash
# from repo root
npm install
# create backend/.env (see backend/.env.example) with DB_* and ENCRYPTION_KEY
npm run dev -w backend
```

`.env` keys of note: `DB_*`, `ENCRYPTION_KEY` (must match whatever encrypted the stored data),
`WORKER_MODE=local` for local agent runs.

Your machine's public IP must be allowed in the Azure SQL firewall.

---

### Run entirely on localhost (no Azure, no Docker)

You can run the full application on localhost with **zero external dependencies** — no Azure
SQL, no Docker, no network connection required after initial setup. This uses SQL Server
Express LocalDB, a lightweight on-demand SQL engine that speaks the same T-SQL dialect the app
depends on.

> See also: the root [`ARCHITECTURE.md`](../ARCHITECTURE.md) §11 for an overview of this flow.

#### Prerequisites

- **Node.js 20+**
- **SQL Server Express LocalDB** (Windows only)
  - Download: <https://www.microsoft.com/en-us/sql-server/sql-server-downloads>
  - Or via winget: `winget install Microsoft.SQLServer.2022.Express` (select LocalDB feature)
  - If you have Visual Studio installed, the default `(localdb)\MSSQLLocalDB` instance is likely
    already present.

#### Step-by-step

```powershell
# 1. Ensure the LocalDB instance is running
sqllocaldb start MSSQLLocalDB

# 2. Create the database (one-time)
sqlcmd -S "(localdb)\MSSQLLocalDB" -Q "CREATE DATABASE TecFactory;"
```

```bash
# 3. Install dependencies (from repo root)
npm install

# 4. Configure environment
cp backend/.env.local.example backend/.env
# Edit backend/.env — generate and set ENCRYPTION_KEY:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. Run database migrations (creates all tables)
npm run migrate -w backend

# 6. Seed a test user and sample tasks
npm run seed:local -w backend

# 7. Start the server
npm run dev -w backend
```

Open <http://localhost:3500> and log in with:
- **Email:** `local-dev@example.com`
- **Password:** `localdev123`

You'll see a populated Kanban board with sample tasks across all types, priorities, and states.

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

#### Seed script details

The `seed:local` script is idempotent — safe to re-run without duplicating data. It creates:
- A test user (`local-dev@example.com` / `localdev123`)
- A "Local Dev" tab
- 7 sample tasks spanning bug/feature/improvement types, P1–P4 priorities, and
  todo/in-progress/developed states

#### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `sqlcmd` not found | Install [SQL Server command-line tools](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-utility) or use the `SqlLocalDB` utility directly. |
| Connection refused / named pipe error | Run `sqllocaldb start MSSQLLocalDB` to ensure the instance is running. |
| Login failed | LocalDB uses Windows auth by default — make sure `DB_USER` is empty in `.env`. |
| `ENCRYPTION_KEY` error on startup | Generate and set a 64-char hex key (see step 4 above). |

---

## Deploy

See root `ARCHITECTURE.md` §6. Short version, from repo root:

```bash
az acr build --registry kiroFactory --image kirofactory-api:latest --file Dockerfile .
az containerapp update --name kirofactory-api --image kirofactory.azurecr.io/kirofactory-api:latest
```
