# KiroFactory — Architecture & Operations Guide

> This document is the top-level reference for the KiroFactory project. It describes what
> the project is, how it is structured, how it is deployed on Azure, and where to look when
> something breaks. If you are an AI agent or a new developer, read this first.

---

## 1. What is KiroFactory?

KiroFactory is a web-based orchestration platform for running autonomous **Kiro CLI agent
sessions** against code repositories. It presents a Kanban-style board (like a lightweight
Jira/Trello) where each **task** can be picked up by an AI agent that clones a repo, does the
work, and opens a pull request.

The core idea:
- Users create **tasks** on a **board (tab)**. Each tab maps to one Git repository.
- Users start **sessions**. A session runs a Kiro agent (`kiro-cli acp`) either interactively
  or in an autonomous loop that claims tasks from the board.
- In production, each session runs in its **own isolated container** (Azure Container Apps Job),
  clones the repo, works the task, commits, pushes, and opens a PR against `develop`.

### Key concepts / terminology

| Term | Meaning |
|------|---------|
| **Task** | A work item stored in the `tasks` DB table. NOT an IDE task or spec task. |
| **Tab / Board** | A project grouping (`tabs` table). Each tab maps to one repository and has its own MCP config. |
| **Session** | A running (or stopped) Kiro agent instance (`sessions` table). |
| **Agent** | A Kiro agent definition (prompt + tools), e.g. `developer-agent`. |
| **Worker** | The container that actually runs `kiro-cli` for a session (ACA Job execution). |
| **Orchestrator** | The backend API server that manages sessions and triggers workers. |
| **MCP** | Model Context Protocol servers (Atlassian, Azure DevOps, AWS) the agent can call. |

---

## 2. Repository Structure

```
KiroFactory/
├── ARCHITECTURE.md            ← you are here (top-level guide)
├── Dockerfile                 ← builds the backend+frontend image (kirofactory-api)
├── .dockerignore
├── package.json               ← npm workspaces root (backend + frontend)
├── package-lock.json          ← single lockfile for the whole monorepo
├── SPEC.md, TASKS.md          ← original project spec and task notes
│
├── backend/                   ← the orchestrator (Express + WebSocket + DB)
│   ├── README.md              ← backend-specific guide
│   ├── src/                   ← TypeScript source
│   └── sql/schema.sql         ← database schema
│
├── frontend/                  ← the static web UI
│   ├── README.md              ← frontend-specific guide
│   └── public/                ← HTML/CSS/JS served by the backend
│
└── worker/                    ← the Kiro session worker (ACA Job image)
    ├── Dockerfile             ← builds kirofactory-worker image
    ├── worker.js              ← worker agent script
    └── package.json
```

The project is an **npm workspaces monorepo**. There is a single `package-lock.json` at the
root; the backend and frontend are workspaces. Any Docker build must copy the root
`package.json` + `package-lock.json` and run `npm ci` from the root.

---

## 3. The Three Deployables

KiroFactory is split into three independently deployed pieces:

### a) Backend / Orchestrator — `kirofactory-api`
- Azure Container App (always-on, min 1 replica).
- Express REST API + WebSocket server on port **3500**.
- Serves the frontend static files (same origin — no separate frontend host today).
- Manages session lifecycle, talks to the database, triggers worker jobs.
- Image: `kirofactory.azurecr.io/kirofactory-api:latest`.

### b) Frontend — static files
- Plain HTML/CSS/JS in `frontend/public/`.
- Currently served **by the backend** (bundled into the same image / same origin).
- No build step. See `frontend/README.md`.

### c) Worker — `kirofactory-worker`
- Azure Container Apps **Job** (event-driven, manual trigger, scale-to-zero).
- Each session start triggers one Job execution.
- Runs `kiro-cli acp`, clones the repo, commits/pushes, opens a PR, then exits.
- Image: `kirofactory.azurecr.io/kirofactory-worker:latest`.
- See `worker/` and the ACA integration in `backend/src/aca-worker-spawner.ts`.

```
Browser ──HTTPS/WSS──> kirofactory-api (Container App)
                            │
                            ├── Azure SQL (TecFactory DB)
                            │
                            └── triggers ──> kirofactory-worker (ACA Job, 1 per session)
                                                  │
                                                  ├── kiro-cli acp (the agent)
                                                  ├── git clone / commit / push / PR
                                                  └── connects back to orchestrator via /internal/worker WS
```

---

## 4. Azure Environment

Everything lives in subscription **Visual Studio Professional-Abonnement**
(`REDACTED_SUBSCRIPTION_ID`), resource group **`SandboxForRM`**,
region **Germany West Central**.

### Resources

| Resource | Type | Purpose |
|----------|------|---------|
| `kiroFactory` | Container Registry (ACR) | Stores `kirofactory-api` and `kirofactory-worker` images. Login server: `kirofactory.azurecr.io`. Admin user enabled. |
| `managedEnvironment-SandboxForRM-8f71` | Container Apps Environment | Hosts the API container app and the worker job. |
| `kirofactory-api` | Container App | The backend/orchestrator. External ingress, port 3500. |
| `kirofactory-worker` | Container Apps Job | The Kiro session worker. Manual trigger. |
| `rm-sandbox` | Azure SQL Server | Database server. `REDACTED_DB_SERVER`. |
| `rm-sandbox/TecFactory` | Azure SQL Database | The application database (tasks, tabs, sessions, users, credentials). |
| `workspacesandboxforrm86f0` | Log Analytics Workspace | Collects Container App logs (the one bound to the ACA environment). |

> Note: `func-tecTactory-tasks`, `sandboxforrmaebf`, and the extra `workspace-*` items belong to
> other experiments in the same resource group and are not part of KiroFactory.

### Public URL

```
https://kirofactory-api.orangeriver-26cd2328.germanywestcentral.azurecontainerapps.io
```

- `/` → frontend (login required)
- `/api/health` → health check (public): `{"status":"running","database":"connected"}`
- `/api/*` → REST API (JWT-protected)
- `/ws` → client WebSocket (JWT cookie auth)
- `/internal/worker` → worker ↔ orchestrator WebSocket (shared-secret auth)

### Managed Identity & permissions

The `kirofactory-api` Container App uses a **system-assigned managed identity** to call the
Azure Container Apps management API and start worker Job executions. That identity must hold a
role (e.g. **Contributor** or Container Apps Contributor) on the `kirofactory-worker` job.
If you see `ChainedTokenCredential authentication failed` in session logs, the managed identity
is missing or lacks permission.

---

## 5. Configuration (environment variables)

Set on the `kirofactory-api` Container App. Secrets are plain env vars today (move to Key Vault
later — see backlog).

| Variable | Purpose |
|----------|---------|
| `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DB_ENCRYPT`, `DB_TRUST_SERVER_CERTIFICATE` | Azure SQL connection. |
| `PORT` | 3500. |
| `NODE_ENV` | `production`. |
| `ENCRYPTION_KEY` | AES-256-GCM master key for encrypting user credentials/API keys. **Must match across environments or stored secrets become unreadable.** |
| `WORKER_MODE` | `remote` (use ACA Jobs) or `local` (spawn kiro-cli as child process, dev only). |
| `ACA_SUBSCRIPTION_ID` | Azure subscription for the Jobs API. |
| `ACA_RESOURCE_GROUP` | `SandboxForRM`. |
| `ACA_JOB_NAME` | `kirofactory-worker`. |
| `ACA_WORKER_IMAGE` | `kirofactory.azurecr.io/kirofactory-worker:latest`. **Required for ACA mode** — if missing, `loadAcaConfig()` returns null and sessions fail with "ACA mode enabled but configuration is missing". |
| `ACA_ORCHESTRATOR_URL` | `wss://<fqdn>/internal/worker` — where workers connect back. |
| `ACA_WORKER_SECRET` | Shared secret for worker ↔ orchestrator auth. |
| `JWT_SECRET` | (optional) JWT signing secret. Falls back to a dev default if unset. |

---

## 6. Build & Deploy

No local Docker required — Azure Container Registry builds images in the cloud.

### Backend (from repo root)

```bash
# Build + push the image
az acr build --registry kiroFactory --image kirofactory-api:latest --file Dockerfile .

# Deploy the new image (forces a fresh revision — a plain restart reuses the cached image)
az containerapp update --name kirofactory-api --image kirofactory.azurecr.io/kirofactory-api:latest
```

### Worker

```bash
az acr build --registry kiroFactory --image kirofactory-worker:latest --file worker/Dockerfile worker/
```

The Job picks up `:latest` on the next execution — no redeploy needed (but pin a digest for
production reliability).

### Important build notes
- The monorepo uses a single root lockfile. The Dockerfile copies root `package.json` +
  `package-lock.json` and runs `npm ci` from root, then `npm run build -w backend`.
- The worker image installs `kiro-cli` from `https://cli.kiro.dev/install` and needs `unzip`,
  `git`, `curl`, `ca-certificates`.

---

## 7. Where to find logs

### Container App logs (backend)
Portal: **Container App `kirofactory-api` → Monitoring → Log stream** (live) or **Logs** (query).

CLI:
```bash
az containerapp logs show --name kirofactory-api --resource-group SandboxForRM --tail 100
az containerapp logs show --name kirofactory-api --resource-group SandboxForRM --follow
```

### Worker Job logs
Portal: **Container App Job `kirofactory-worker` → Execution history →** pick an execution → logs.

CLI:
```bash
az containerapp job execution list --name kirofactory-worker --resource-group SandboxForRM -o table
```

### Log Analytics (persistent, queryable)
Workspace `workspacesandboxforrm86f0`. Use the `ContainerAppConsoleLogs_CL` and
`ContainerAppSystemLogs_CL` tables. Example KQL:
```kql
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "kirofactory-api"
| order by _timestamp_d desc
| take 100
```

### In-app error store
The backend keeps a lightweight error log surfaced in the UI under the **Errors** tab
(see `error-store.ts` and `routes/errors.ts`).

---

## 8. Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/api/health` shows `database: unavailable` | Azure SQL firewall blocking ACA outbound IPs | Enable "Allow Azure services" on `rm-sandbox`, or add IPs. |
| Container crashes on boot with `spawn kiro-cli ENOENT` | Orchestrator tried to run kiro-cli locally (local mode) but it's not in the image | Set `WORKER_MODE=remote`. |
| `Fatal: ACA mode enabled but configuration is missing` | An `ACA_*` env var is missing (often `ACA_WORKER_IMAGE`) | Add all required ACA vars, restart. |
| `ChainedTokenCredential authentication failed` | Managed identity missing or no role on the job | Enable system-assigned identity on `kirofactory-api`, grant Contributor on the job. |
| WebSocket `Invalid frame header` | ACA ingress transport wrong | Ingress transport must be `http` (HTTP/1.1). `http2` breaks WebSockets. |
| Old sessions error on startup | Sessions left `running` in DB from a previous host | Mark them `stopped` in the DB; they auto-restart on boot. |
| Deploy didn't take effect | Restart reuses cached image | Use `az containerapp update --image ...` to force a new revision. |

---

## 9. Data model (high level)

Azure SQL database `TecFactory`. Core tables:
- `users` — accounts; stores `password_hash` (bcrypt) and `kiro_api_key_encrypted` (AES-256-GCM).
- `credentials` — per-user encrypted service credentials (ADO PAT, Atlassian, AWS).
- `tasks` — the work items (title, description, priority 1–4, type, state, origin).
- `tabs` — boards; each maps to a repository and holds MCP config.
- `task_tabs` — many-to-many between tasks and tabs.
- `sessions` — agent sessions (agent, status, tab assignment, loop config).

See `backend/sql/schema.sql` for the authoritative definition and `backend/README.md` for
details on the data-access layer.

---

## 10. Security notes

- User credentials and Kiro API keys are encrypted at rest (AES-256-GCM, `crypto.ts`) and are
  **only** decrypted in backend memory when spawning a worker. They are never returned to the
  browser — the credentials API only reports which keys are set.
- The API is protected by JWT auth (cookie `kf_session`). SSO (Entra ID / Okta) is a planned,
  low-priority enhancement.
- Move plaintext env-var secrets to Azure Key Vault before treating this as production-grade.
