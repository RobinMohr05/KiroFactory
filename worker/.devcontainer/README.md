# Worker devcontainer — design in progress

> **Status:** planning stage. Nothing in this folder is implemented yet — this file records the
> agreed design so implementation can proceed incrementally. See
> [`ARCHITECTURE.md` §12](../../ARCHITECTURE.md#12-devcontainer-based-worker-design-in-progress)
> for the full writeup; this file is the worker-local pointer to it plus setup instructions once
> they exist.

## What this replaces

`worker/Dockerfile` (the current hand-rolled `node:22-slim` image) will be replaced by a
`devcontainer.json` + `Dockerfile` pair in this folder, built with the standard
[devcontainer CLI](https://containers.dev/implementors/features/) spec instead of a plain
`docker build`. Same runtime contents as today — git, curl, node, `kiro-cli` — just defined in a
way that's usable both for the hosted (ACA) build and, eventually, for local development.

## Why: one image, one code path

Today there are two separate implementations of "run kiro-cli and stream output":

- `worker/worker.js` — what actually runs in production (ACA Job, WebSocket callback to the
  orchestrator).
- `backend/src/agent/kiro-runner.ts` — a **separate** ACP-over-stdio implementation used only for
  local-mode sessions (`WORKER_MODE=local`), spawned as a bare child process directly on the
  orchestrator's own host, no container involved.

The plan converges both onto `worker.js`, running inside this devcontainer image, for both
environments — see ARCHITECTURE.md §12 for the reasoning and the concurrency model (fresh
container per session, same isolation model as separate ACA Job executions).

## Planned local setup (not yet implemented)

Local sessions will run inside a **dedicated WSL2 distro** (working name `kirofactory-docker`) —
a minimal `Ubuntu-24.04` base with **Docker Engine** installed via the official
`get.docker.com` script (not Docker Desktop) — kept separate from any general-purpose WSL distro
you already have. A `setup-wsl.ps1` script (planned, not yet written) will create and provision
it idempotently, so no manual one-time setup is required on a fresh machine — the orchestrator
will trigger this automatically before the first local session start if the distro isn't already
there.

Each local session becomes a fresh, one-shot `docker run` inside that distro from this image —
mirroring exactly how `backend/src/aca-worker-spawner.ts` starts a fresh ACA Job execution per
session today. The git clone happens entirely inside the container's own filesystem; nothing is
mounted in from the Windows host.

## Current status

Nothing here yet. `worker/Dockerfile` is still the live production image — see the root
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) §3(c) and §6 for how it's built and deployed today.
