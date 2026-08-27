# Vibecode Heaven — Architecture & Operations Guide

> This document is the top-level reference for the Vibecode Heaven project. It describes what
> the project is, how it is structured, how it is deployed on Azure, and where to look when
> something breaks. If you are an AI agent or a new developer, read this first.

---

## 1. What is Vibecode Heaven?

Vibecode Heaven is a web-based orchestration platform for running autonomous **Kiro CLI agent
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
VibecodeHeaven/
├── ARCHITECTURE.md            ← you are here (top-level guide)
├── Dockerfile                 ← builds the backend+frontend image (vibecode-heaven-api)
├── .dockerignore
├── package.json               ← npm workspaces root (backend + frontend)
├── package-lock.json          ← single lockfile for the whole monorepo
├── SPEC.md, TASKS.md          ← original project spec and task notes
│
├── backend/                   ← the orchestrator (Express + WebSocket + DB)
│   ├── README.md              ← backend-specific guide
│   └── src/                   ← TypeScript source (db/ holds the Neo4j data-access layer)
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
                            ├── Neo4j AuraDB Free (Bolt, neo4j+s://)
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
| Neo4j AuraDB Free (`845e53c6.databases.neo4j.io`) | External managed service (Neo4j Aura Console, **not** in `SandboxForRM`) | The live application database (tasks, tabs, sessions, users, agents, credentials, settings) — a graph model, see §9. Reached over public Bolt (`neo4j+s://`). |
| `workspacesandboxforrm86f0` | Log Analytics Workspace | Collects Container App logs (the one bound to the ACA environment). |

> `rm-sandbox` (Azure SQL Server, formerly hosting the `TecFactory` database) is **retained but
> no longer used** by the running app — kept as a rollback safety net per an explicit decision,
> not deleted. It is not the application database anymore; see §9.

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
Azure Container Apps management API and start/stop worker Job executions (via
`DefaultAzureCredential` in `aca-worker-spawner.ts`).

That identity must hold the built-in **Container Apps Jobs Operator** role
(`b9a307c4-5aa3-4b52-ba60-2b17c136cd7b`), **scoped to the `kirofactory-worker` job**. This is the
least-privilege role that covers exactly `Microsoft.App/jobs/read` + `Microsoft.App/jobs/*/action`
(start and stop). Do **not** grant Contributor — it is far broader than needed.

> This is NOT a user-credential concern. The Azure DevOps PAT, Atlassian, and AWS credentials are
> injected into the worker container *after* it starts, so they can never cause a start failure.
> A start failure is always about the orchestrator identity's own RBAC.

**Symptoms of a missing role:**
- `AuthorizationFailed` / HTTP 403 when starting a session (`Microsoft.App/jobs/start/action` denied).
- `ChainedTokenCredential authentication failed` — the system-assigned identity is disabled entirely.
- On boot the log shows `[startup] ⚠ ACA preflight FAILED — …` (see the preflight in `index.ts`).

**Fix (portal):** Container App Job `kirofactory-worker` → **Access control (IAM)** → **Add role
assignment** → role **Container Apps Jobs Operator** → assign to **Managed identity →
`kirofactory-api`** → Review + assign. Propagation takes a few minutes.

**Fix (CLI):**
```bash
PRINCIPAL_ID=$(az containerapp show -g SandboxForRM -n kirofactory-api --query identity.principalId -o tsv)
JOB_ID=$(az containerapp job show -g SandboxForRM -n kirofactory-worker --query id -o tsv)
az role assignment create \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role b9a307c4-5aa3-4b52-ba60-2b17c136cd7b \
  --scope "$JOB_ID"
```

> Note: deploying with `az containerapp update --image ...` only swaps the image; it does **not**
> apply the Bicep role assignment. If the app is ever recreated, its system-assigned identity gets
> a new object id and this role must be re-granted (re-running `infra/deploy-app.sh` does this).

---

## 5. Configuration (environment variables)

Set on the `kirofactory-api` Container App. Secrets are plain env vars today (move to Key Vault
later — see backlog).

| Variable | Purpose |
|----------|---------|
| `NEO4J_URI` | Neo4j Bolt connection string, e.g. `neo4j+s://845e53c6.databases.neo4j.io`. |
| `NEO4J_USERNAME` | Neo4j basic-auth username (default `neo4j`). |
| `NEO4J_PASSWORD` | Neo4j basic-auth password. |
| `NEO4J_DATABASE` | Optional database name within the instance. AuraDB Free provisions one database matching the instance ID; leave unset to let the driver use the server's default database. |
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
az acr build --registry kiroFactory --image kirofactory-worker:latest --file worker/.devcontainer/Dockerfile worker/
```

The Job picks up `:latest` on the next execution — no redeploy needed (but pin a digest for
production reliability).

### Important build notes
- The monorepo uses a single root lockfile. The Dockerfile copies root `package.json` +
  `package-lock.json` and runs `npm ci` from root, then `npm run build -w backend`.
- The worker image installs `kiro-cli` from `https://cli.kiro.dev/install` and needs `unzip`,
  `git`, `curl`, `ca-certificates`.
- `worker/.devcontainer/Dockerfile` deliberately does **not** set `NODE_ENV=production` (unlike
  the root Dockerfile). The worker's job is to `npm ci`/`npm install --include=dev` inside an
  arbitrary cloned **target** repo so the agent can run its tests/build — `NODE_ENV=production`
  makes npm's `omit` config default to `dev`, which silently skips writing devDependencies (test
  runner, compiler, type stubs) to `node_modules` even though the install reports success. That
  bug is what made `vitest`/`typescript` disappear from every agent session while `npm install`
  exited 0.
  See the failure mode table below. (The worker's own dependency-install logic lives entirely
  in `worker/worker.js` — there is no separate `git-workspace.ts` module; that name belonged to
  a removed standalone dev-agent path.)

### Infrastructure as code (source of truth for config + RBAC)

`az containerapp update --image ...` is fine for a quick **image-only** swap, but it does NOT
apply env config, secrets, the worker Job, or the RBAC that lets the orchestrator start the job.
For anything beyond an image bump, use the Bicep deploy so config can't drift:

```bash
export NEO4J_URI=neo4j+s://845e53c6.databases.neo4j.io NEO4J_PASSWORD=<pw>
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=<existing 64-char hex — must not change or stored secrets break>
export ACA_WORKER_SECRET=$(openssl rand -hex 32)
# optional org-level git-clone fallback for workers:
# export AZURE_DEVOPS_EXT_PAT=<pat>
cd infra && ./deploy-app.sh --what-if   # preview
cd infra && ./deploy-app.sh             # apply
```

`infra/modules/container-app.bicep` deploys the orchestrator (`kirofactory-api`), and via
`infra/modules/worker-job.bicep` it also provisions the worker Job (`kirofactory-worker`) **and**
the least-privilege `Container Apps Jobs Operator` role assignment scoped to that job. That means
a fresh deploy always yields a consistent app + job + RBAC — the class of failure where the job
was hand-created and the role was missing can no longer happen.

> The Bicep app layer is reconciled to the live `SandboxForRM` environment (real names:
> app `kirofactory-api`, ACR `kiroFactory`, env `managedEnvironment-SandboxForRM-8f71`, resolved by
> `deploy-app.sh` via `CONTAINERAPP_ENV`). `main.bicep` remains a greenfield definition of the
> environment itself — see the drift note at the top of that file.

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
| `/api/health` shows `database: unavailable` | Wrong/expired `NEO4J_PASSWORD`, the AuraDB instance was deleted/renamed, or (most common) the Free-tier instance auto-paused after 72h of inactivity and needs a moment to resume | Verify `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` are current in the Aura Console; on auto-pause, the first connection triggers a resume — `connection.ts` uses a generous 60s `connectionTimeout` for exactly this, so retry after ~a minute. |
| Container crashes on boot with `spawn kiro-cli ENOENT` | Orchestrator tried to run kiro-cli locally (local mode) but it's not in the image | Set `WORKER_MODE=remote`. |
| `Fatal: ACA mode enabled but configuration is missing` | An `ACA_*` env var is missing (often `ACA_WORKER_IMAGE`) | Add all required ACA vars, restart. |
| `ACA job start was denied by Azure (HTTP 403 … AuthorizationFailed)` | Orchestrator managed identity lacks the role on the worker job (often after an `az containerapp update`-only deploy or an app recreation) | Grant **Container Apps Jobs Operator** scoped to `kirofactory-worker` — see §4 "Managed Identity & permissions". NOT a credential issue. |
| `ChainedTokenCredential authentication failed` | System-assigned identity disabled/missing on `kirofactory-api` | Enable system-assigned identity on `kirofactory-api`, then grant Container Apps Jobs Operator on the job. |
| `ACA job start failed … 404 Not Found` | Worker job missing, or `ACA_JOB_NAME`/`ACA_RESOURCE_GROUP`/`ACA_SUBSCRIPTION_ID` wrong | Verify the job exists (`az containerapp job show -g SandboxForRM -n kirofactory-worker`) and the env vars match. |
| WebSocket `Invalid frame header` | ACA ingress transport wrong | Ingress transport must be `http` (HTTP/1.1). `http2` breaks WebSockets. |
| Old sessions error on startup | Sessions left `running` in DB from a previous host | Mark them `stopped` in the DB; they auto-restart on boot. |
| Deploy didn't take effect | Restart reuses cached image | Use `az containerapp update --image ...` to force a new revision. |
| Agent session can't run tests — `sh: 1: vitest: not found` / `npm error code 127`, even right after `npm install` reported success | `NODE_ENV=production` was set in the worker container (npm's `omit` config defaults to `dev` under that env, so devDependencies resolve into `package-lock.json` but are never installed to disk) | Fixed by removing `ENV NODE_ENV=production` from `worker/.devcontainer/Dockerfile` and adding `--include=dev` to every install call in `worker.js`. If this resurfaces, check for `NODE_ENV=production` anywhere in the worker's env (Dockerfile, ACA job env vars, or an `.npmrc`/`omit` setting) — it should never be set for the container that installs a target repo's own dependencies. |

---

## 9. Data model (high level)

Neo4j (AuraDB Free), a property graph — not relational tables. Core node labels:
- `User` — accounts; stores `passwordHash` (bcrypt) and `kiroApiKeyEncrypted` (AES-256-GCM),
  plus the per-user encrypted service credentials (ADO PAT, Atlassian, AWS) as opaque properties.
- `Tab` — boards; each maps to a repository and holds MCP config via `HAS_MCP_CONFIG`.
- `Task` — the work items (title, description, priority 1–4, type, state, origin), including a
  task-dependency feature: a task can `DEPENDS_ON` other tasks, and the API computes `isBlocked`/
  `blockedBy` at read time (never stored) so a task isn't claimable by an agent until its
  dependencies are done.
- `Agent` — agent definitions (prompt, tools, pipeline stage config).
- `Session` — running/stopped Kiro agent instances.
- Sub-nodes: `McpConfig`, `ToolsSettings`, `McpServerConfig`, `RawMcpServerConfig` (linked shapes
  that used to be embedded JSON columns).
- Infrastructure nodes (not domain entities): `Counter` (atomic ID allocation, replacing SQL
  `IDENTITY` columns) and `Settings` (key/value app settings).

Key relationship types: `OWNS` (user → tab/agent/session), `IN_TAB` (task/agent/session → tab,
replacing the old `task_tabs`/`agent_tabs` junction tables), `DEPENDS_ON` (task → task),
`HAS_MCP_CONFIG` / `HAS_MCP_CONFIG_OVERRIDE`, `HAS_TOOLS_SETTINGS`, `HAS_MCP_SERVER` /
`HAS_RAW_MCP_SERVER` (ordered, via a `position` property).

Entity IDs are still plain, stable integers (not Neo4j's internal element IDs) — allocated
atomically per label via the `Counter` nodes, so existing conventions that embed them (git branch
names, PR titles, "Task #142") keep working unchanged.

See each `backend/src/db/*.ts` file's header comment for the model it manages, and
[`.kiro/specs/neo4j-migration/design.md`](.kiro/specs/neo4j-migration/design.md) ("Graph data
model" section) for the full authoritative schema, including every node property and the
concurrency-safe task-claiming design.

---

## 10. Security notes

- User credentials and Kiro API keys are encrypted at rest (AES-256-GCM, `crypto.ts`) and are
  **only** decrypted in backend memory when spawning a worker. They are never returned to the
  browser — the credentials API only reports which keys are set.
- The API is protected by JWT auth (cookie `kf_session`). SSO (Entra ID / Okta) is a planned,
  low-priority enhancement.
- Move plaintext env-var secrets to Azure Key Vault before treating this as production-grade.

---

## 11. Running locally without Azure

The core application (UI, board, task CRUD, auth, WebSocket sync) can run on localhost with no
Azure access at all. This is the recommended path for new developers or any environment without
Azure access.

Unlike the old SQL Server Express LocalDB setup, there's no per-developer database anymore.
Everyone connects to the **same shared AuraDB Free instance** used in production — an explicitly
accepted tradeoff (Requirement 7.2 of the Neo4j migration spec), not an oversight. That means
your test data can show up in a teammate's local environment, and vice versa.

**Requirements:** Node.js 20+. WSL2 + Docker for starting agent sessions (see §12) — everything
else needs no database software and no Docker.

**Quick summary:**

1. Get the shared Neo4j credentials from a teammate or the team's credential store (variable
   names: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` — see
   `backend/.env.example`).
2. `cp backend/.env.example backend/.env` and fill in the `NEO4J_*` vars + `ENCRYPTION_KEY`.
3. `npm install`
4. `npm run dev -w backend` → open <http://localhost:3500>

There's no separate manual migration step — the constraint/index bootstrap in
`backend/src/db/migrate.ts` runs automatically and idempotently on every startup.

**What works without WSL/Docker:** Everything except starting agent sessions. The full UI,
task/board CRUD, auth, WebSocket sync, and drag-and-drop all work. Starting a session
(`WORKER_MODE=local`, the default when no ACA config is present) now spawns a local Docker
container inside a dedicated WSL2 distro — see §12 for the full design, setup, and
troubleshooting. Run `pwsh worker/.devcontainer/setup-wsl.ps1` once to provision the distro (it's
also auto-checked, but not auto-provisioned, before the first session start — a missing/unhealthy
distro surfaces as a clear startup log line and a session-start error instead of a silent hang).

For more detail (including the current status of the local seed script), see
[`backend/README.md` § "Run entirely on localhost"](backend/README.md#run-entirely-on-localhost-no-azure-no-docker).

---

## 12. Devcontainer-based worker (WSL2 + Docker for local sessions)

Local-mode sessions and hosted (ACA) sessions run the **same worker image**
(`worker/.devcontainer/Dockerfile`) and the **same worker code** (`worker/worker.js`) — there is
no separate local-only execution path anymore. `backend/src/agent/kiro-runner.ts` (a bare
`kiro-cli acp` child process on the orchestrator's own host, ACP-over-stdio, no container) still
exists, but only for `forceLocal` sessions — the task planner's pre-warmed session pool
(`backend/src/planner-session-pool.ts`), a separate low-latency planning concern unrelated to
dev-session worker mode. Every other session (interactive or loop, editor or inspector agent) now
goes through the containerized worker path, choosing ACA or local Docker based on `WORKER_MODE`.

### How it works

- **Image:** `worker/.devcontainer/Dockerfile` + `devcontainer.json` — same runtime deps as
  before (git, curl, node, `kiro-cli`), just defined via the devcontainer spec so it's buildable
  with the standard `devcontainer build` CLI in addition to plain `docker build`. This replaced
  `worker/Dockerfile` (deleted).
- **Hosted/production path (ACA):** unchanged in shape. `az acr build --file
  worker/.devcontainer/Dockerfile worker/` (or `devcontainer build` in CI — see the
  `kirofactory-api-AutoDeployTrigger-*.yml` workflow) builds this same Dockerfile, pushes to
  `kiroFactory` ACR, and the ACA Job runs it headless exactly as before — see §3(c) and §6.
  Implemented in `backend/src/aca-worker-spawner.ts` (unchanged).
- **Local path:** `backend/src/wsl-worker-spawner.ts` — a **fresh Docker container per session**
  (`docker run -d --rm`, one-shot, not a long-lived `devcontainer up` shell), started from the
  *same* image inside a **dedicated WSL2 distro** running Docker Engine. Structurally parallel to
  `aca-worker-spawner.ts`: `loadWslConfig()`/`startWorkerJob()`/`stopWorkerJob()`/
  `getWorkerJobStatus()`/`verifyWslAccess()` mirror the ACA module's shape exactly, driven via
  `execFile("wsl.exe", ["-d", "kirofactory-docker", "--", "docker", ...])`.
- **Dispatch:** `backend/src/session-manager.ts`'s `ContainerWorkerSpawner` abstraction
  (`resolveContainerSpawner()`) picks the ACA or WSL spawner based on `WORKER_MODE`/`ACA_MODE`,
  and `runSessionAca()` (despite the name — it's the shared containerized-worker execution path
  for both backends now) uses whichever one it's given. `startSession()`'s only remaining
  hard-coded branch is `forceLocal` → `KiroRunner`; everything else goes through
  `resolveContainerSpawner()`.

### Why concurrency "just works" here

Each session gets its **own container**, not a shared sandbox — Docker's normal container
isolation (separate filesystem, separate process namespace) is the isolation boundary, exactly
like separate ACA Job executions. One WSL distro's Docker daemon can run any number of containers
at once, so N concurrent local sessions = N concurrent containers, each on its own branch, own
repo clone, own working directory, with no risk of collision even if two sessions target the same
repository. Nothing is mounted in from the Windows host — **the git clone happens entirely inside
the container's own filesystem** (physically backed by the WSL distro's virtual disk), so there's
no Windows↔WSL filesystem I/O in the hot path, and the orchestrator never touches those files
directly — it only talks to each container over its own WebSocket connection to
`/internal/worker`, same as it does with an ACA container.

Each session's worker container and its MCP proxy sidecar (if configured) are joined to a
per-session Docker bridge network (`kirofactory-session-<id>`) so they can reach each other by
container name — the local analogue of ACA's same-revision shared-localhost networking, which
doesn't apply to independent `docker run` invocations. Container names:
`kirofactory-worker-<sessionId>` and `kirofactory-mcp-proxy-<sessionId>`.

### Dedicated WSL distro

A WSL2 distro dedicated to this purpose, `kirofactory-docker`, runs Docker Engine directly (not
Docker Desktop's Windows integration), kept separate from any general-purpose WSL distro a
developer already has.

**Base image:** minimal Ubuntu (`Ubuntu-24.04`) with **Docker Engine** installed via the official
`get.docker.com` convenience script — not Docker Desktop. (Considered and rejected: Microsoft's
`wslc.exe` built-in WSL container CLI would remove the need for a dedicated distro entirely, but
it's pre-release-only as of this writing — worth revisiting once it reaches general availability.)

**Provisioning:** `worker/.devcontainer/setup-wsl.ps1` — idempotent; safe to re-run.

```powershell
# One-time setup (or to repair a broken distro):
pwsh worker/.devcontainer/setup-wsl.ps1

# Cheap health check only (no mutation) — this is what wsl-worker-spawner.ts
# calls before every local session start:
pwsh worker/.devcontainer/setup-wsl.ps1 -CheckOnly
```

It creates the distro if missing (`wsl --install -d Ubuntu-24.04 --name kirofactory-docker
--no-launch`), installs Docker Engine if missing, and starts the daemon if it isn't responding.
`wsl-worker-spawner.ts` calls the `-CheckOnly` health check (not full provisioning) lazily before
starting a local session — a missing or unhealthy distro surfaces as an actionable error message
(pointing at this script) rather than a confusing container-start failure.

**Orchestrator → container connection:** `ORCHESTRATOR_URL` defaults to
`ws://host.docker.internal:3500/internal/worker`; the worker container is started with `--add-host
host.docker.internal:host-gateway` so that resolves correctly from inside WSL's Docker network.
Session env vars (`SESSION_ID`, `REPO_URL`, `DEV_BRANCH`, `AGENT_CONFIG_JSON_B64`, etc. — the same
contract `worker.js` already expects from ACA) are passed to `docker run` unchanged; `worker.js`
needed **no code changes** to support this — it only ever knew "connect back over WebSocket," not
which host started it.

### Configuration (environment variables)

| Variable | Purpose |
|----------|---------|
| `WSL_DISTRO_NAME` | Dedicated distro name. Defaults to `kirofactory-docker`. |
| `WSL_WORKER_IMAGE` | Local worker image reference. Defaults to `kirofactory-worker:local` — build it with `docker build -f worker/.devcontainer/Dockerfile -t kirofactory-worker:local worker/` inside the distro, or via `devcontainer build`. |
| `WSL_PROXY_IMAGE` | Local MCP proxy sidecar image reference. Optional — omit to run without the proxy sidecar. |
| `WSL_ORCHESTRATOR_URL` | Defaults to `ws://host.docker.internal:3500/internal/worker`. |
| `ACA_WORKER_SECRET` (or `WSL_WORKER_SECRET`) | Shared secret for worker ↔ orchestrator auth. **Required** — local mode is disabled (`loadWslConfig()` returns `null`) without one. Reusing `ACA_WORKER_SECRET` lets a single `.env` value cover both modes. |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | Git identity for commits inside the local worker container. Default to a `(local)`-suffixed identity if unset. |
| `AZURE_DEVOPS_EXT_PAT` | Org-wide git-clone fallback PAT — same variable ACA mode uses. |

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Local worker mode requires WSL/Docker configuration ... but none is set` | No `ACA_WORKER_SECRET`/`WSL_WORKER_SECRET` in the environment | Set one in `backend/.env`. |
| `'wsl.exe' was not found on PATH` | WSL2 not installed on this machine | Install WSL2 (`wsl --install`), then run `setup-wsl.ps1`. |
| `WSL distro "kirofactory-docker" does not exist yet` | Distro not provisioned | Run `pwsh worker/.devcontainer/setup-wsl.ps1`. |
| `Docker daemon is not running inside WSL distro "kirofactory-docker"` | dockerd not started in the distro | Run `pwsh worker/.devcontainer/setup-wsl.ps1` (restarts it), or manually: `wsl -d kirofactory-docker -- sudo service docker start`. |
| Local session container never connects | Wrong `WSL_ORCHESTRATOR_URL`, or the orchestrator isn't listening on the interface WSL's `host.docker.internal` resolves to | Check `wsl -d kirofactory-docker -- docker logs kirofactory-worker-<sessionId>` for the worker's own connection error. |
| Need to inspect a local session's container directly | — | `wsl -d kirofactory-docker -- docker logs kirofactory-worker-<sessionId>` / `docker exec -it kirofactory-worker-<sessionId> bash`. |
