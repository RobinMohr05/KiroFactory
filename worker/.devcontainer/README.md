# Worker devcontainer

This is the build definition for the KiroFactory worker — the container that runs `kiro-cli`,
clones the target repository, and executes agent sessions. The **same image** built here is used
both by the hosted ACA Job (production) and by local development sessions (via a dedicated WSL2
distro). See [`ARCHITECTURE.md` §12](../../ARCHITECTURE.md#12-devcontainer-based-worker-wsl2--docker-for-local-sessions)
for the full design writeup; this file covers the practical local setup.

## What replaced what

This replaced `worker/Dockerfile` (deleted). Same runtime contents — git, curl, node, `kiro-cli`
— just defined via the [devcontainer spec](https://containers.dev/implementors/features/)
(`devcontainer.json` + `Dockerfile`) so it's buildable with the standard `devcontainer build` CLI
in addition to plain `docker build`.

Local sessions no longer use `backend/src/agent/kiro-runner.ts`'s bare host `kiro-cli acp` spawn
— that module still exists, but only for `forceLocal` sessions (the task planner's pre-warmed
session pool, a separate concern). Every regular dev session — interactive or loop, editor or
inspector agent — now runs `worker/worker.js` inside a container, exactly like production.

## Local setup (one-time)

Local sessions run inside a **dedicated WSL2 distro** (`kirofactory-docker`) — a minimal
`Ubuntu-24.04` base with **Docker Engine** installed via the official `get.docker.com` script (not
Docker Desktop) — kept separate from any general-purpose WSL distro you already have.

```powershell
# Provision the distro (idempotent — safe to re-run, e.g. to repair a broken install):
pwsh worker/.devcontainer/setup-wsl.ps1
```

Then build the worker image inside the distro (or via `devcontainer build`):

```powershell
wsl -d kirofactory-docker -- docker build -f /mnt/c/Projects/1_Work/19_Misc/KiroFactory/worker/.devcontainer/Dockerfile -t kirofactory-worker:local /mnt/c/Projects/1_Work/19_Misc/KiroFactory/worker/
```

(Adjust the path to wherever this repo is checked out on the Windows side — WSL sees Windows
drives under `/mnt/<drive letter>/`.)

Set `ACA_WORKER_SECRET` (or `WSL_WORKER_SECRET`) in `backend/.env` — this is the only strictly
required piece of local WSL configuration; `backend/src/wsl-worker-spawner.ts`'s
`loadWslConfig()` returns `null` (disabling local mode) without it. See `ARCHITECTURE.md` §12's
configuration table for the full list of optional `WSL_*` overrides.

## How it's used

`backend/src/wsl-worker-spawner.ts` starts a **fresh Docker container per session**
(`docker run -d --rm`, one-shot — not a long-lived `devcontainer up` shell) from this image,
inside the `kirofactory-docker` distro, mirroring exactly how `backend/src/aca-worker-spawner.ts`
starts a fresh ACA Job execution per session in production. The git clone happens entirely inside
the container's own filesystem; nothing is mounted in from the Windows host. Multiple sessions
run as multiple concurrent containers — Docker's normal container isolation is the concurrency
boundary, the same way separate ACA Job executions are in production.

Before starting a local session, the spawner runs a cheap health check
(`setup-wsl.ps1 -CheckOnly`) against the distro; if it's missing or unhealthy, the session fails
with an actionable error pointing back at this script rather than hanging or failing obscurely.

## Troubleshooting

See `ARCHITECTURE.md` §12's troubleshooting table for the full list. Quick reference:

```powershell
# Re-provision / repair the distro:
pwsh worker/.devcontainer/setup-wsl.ps1

# Health check only, no mutation:
pwsh worker/.devcontainer/setup-wsl.ps1 -CheckOnly

# Inspect a running/exited session container directly:
wsl -d kirofactory-docker -- docker logs kirofactory-worker-<sessionId>
wsl -d kirofactory-docker -- docker exec -it kirofactory-worker-<sessionId> bash
```
