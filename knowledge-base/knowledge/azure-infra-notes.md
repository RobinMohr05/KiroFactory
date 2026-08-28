# Azure Infrastructure — Actual Resource Names (learned by discovery)

> Moved here from `.kiro/steering/azure-infra-notes.md` on 2026-08-26 — deep infra/debugging
> reference, only relevant when touching Azure resources or logs, not on every request.

The `infra/*.sh` scripts use placeholder defaults (`kirofactory-rg`, `kirofactory-logs`,
`kirofactory-orchestrator`) that do **not** match what is actually deployed. Don't trust
the script defaults — use these confirmed names instead, or re-verify with
`mcp_azure_mcp_group_resource_list` / `mcp_azure_mcp_group_list` if things may have moved.

## Confirmed deployment (as of Aug 2026)

- Subscription: see Azure portal or run `mcp_azure_mcp_subscription_list` to find the active
  subscription (Visual Studio Professional-Abonnement, tenant TecAlliance).
- Resource group: **`SandboxForRM`** (region `germanywestcentral`) — not `kirofactory-rg`.
- Log Analytics workspace: **`workspacesandboxforrm86f0`** — not `kirofactory-logs`. There are
  multiple `workspace-andbox*` workspaces in the same RG (leftovers); this is the one that
  actually receives `ContainerAppConsoleLogs_CL` for the KiroFactory containers.
- Container Apps environment: `managedEnvironment-SandboxForRM-8f71`.
- Container App (API/orchestrator): `kirofactory-api`.
- Container Apps Job (dev-agent worker): `kirofactory-worker` (`Microsoft.App/jobs`).
- Container registry: `kiroFactory` (`kirofactory.azurecr.io`).

## Querying worker/orchestrator logs via Azure MCP

- Use `mcp_azure_mcp_monitor` with `monitor_workspace_log_query`, passing the **workspace
  name** (`workspacesandboxforrm86f0`) and `table: "ContainerAppConsoleLogs_CL"`.
- `monitor_resource_log_query` with a `resource-id` pointing at the Container App Job
  resource does **not** work for this table — it throws `SEM0100: Failed to resolve table
  or column expression named ContainerAppConsoleLogs_CL`. Always go through the workspace
  query path instead.
- `TimeGenerated` comes back as `DD/MM/YYYY HH:mm:ss +00:00` in query results (not ISO) —
  don't misread it as MM/DD.
- Filter by `ContainerName_s == 'worker'` vs `'orchestrator'`, and `ContainerGroupName_s`
  to isolate a single job execution (each run gets a new suffix, e.g.
  `kirofactory-worker-sklbj2i-97z4l`).
- The worker's structured logs (`Log_s`, JSON) only ever contained ACP protocol metadata —
  tool call titles and `status` (`null`/`completed`/`failed`) — not the actual command
  stdout/stderr. This made a real npm/build failure impossible to diagnose from logs alone;
  only the agent's own paraphrased narration (`agent-message` chunks) hinted at the cause.
  Fixed in `worker/worker.js` (commit "feat: capture tool call output text in worker logs")
  by extracting text from `tool_call_update.content[]` / `.rawOutput` and logging +
  forwarding it on failure. If debugging a run from *before* that fix, don't expect to find
  raw command output in the logs — only in the chat transcript's tool-call summaries.

## Querying the same logs with the `az` CLI (Windows/pwsh) — two traps

Works fine as a fallback when the Azure MCP server isn't available, but two things bite on
Windows (verified 2026-08-20):

1. **`az` is a `.cmd` wrapper, so double quotes inside `--analytics-query` get mangled** by
   cmd.exe before Python sees them — you get `SYN0002 ... could not be parsed` or a raw
   `"..." was unexpected at this time`. Write the KQL with **single quotes only** and pass it
   from a PowerShell single-quoted here-string (`@'...'@`), which allows embedded single quotes.
2. **Piping `az` output into `Select-Object`/`Select-String` can silently swallow it entirely**
   (empty result, exit code 0). Redirect to a file and read the file instead.

The workspace **GUID** (not the name) is what this command wants:

```powershell
az monitor log-analytics workspace show -g SandboxForRM -n workspacesandboxforrm86f0 --query customerId -o tsv
# → 55510ef0-80e4-41b9-a8b8-4eab974a391a
$q = @'
ContainerAppConsoleLogs_CL | where TimeGenerated > ago(3h)
| extend sid = tostring(parse_json(Log_s).sessionId) | where sid == '62'
| project TimeGenerated, ContainerName_s, Log_s | order by TimeGenerated asc
'@
az monitor log-analytics query -w <guid> --analytics-query $q -o tsv > $env:TEMP\out.tsv 2>&1
```

`extend sid = tostring(parse_json(Log_s).sessionId)` is the reliable way to pivot by session —
an `extract()` regex against the escaped JSON was unreliable in practice. Orchestrator rows have
`ContainerGroupName_s` like `kirofactory-api--0000084-…`; worker rows are `ContainerName_s == 'worker'`.

Useful for correlating: `az containerapp job execution list -g SandboxForRM -n kirofactory-worker`
shows each worker execution's start/end and status.

### Worker executions die at the 1-hour mark, by design

`infra/modules/worker-job.bicep` sets `replicaTimeout: 3600`, and the execution history bears it
out — every long-running loop session's worker ends ~59m40s after it starts, cleanly
(`worker-shutdown` exit 0 → the session is marked `completed`). So a loop session is not actually
endless: expect an hourly restart. When reading log history, don't mistake that hourly boundary
for a crash.

## Setting up the Azure MCP server

Microsoft's official `@azure/mcp` server (added to `~/.kiro/settings/mcp.json` as
`"azure-mcp": { "command": "npx", "args": ["-y", "@azure/mcp@latest", "server", "start"] }`)
authenticates via the existing `az login` / Azure CLI session — no separate credentials
needed. It exposes `mcp_azure_mcp_monitor` (Log Analytics KQL, activity logs, metrics),
`mcp_azure_mcp_group_list`/`group_resource_list` (resource discovery), etc. Cannot edit
`.kiro/settings/mcp.json` directly (tool-permission denied by workspace rules) — ask the
user to add/edit it themselves.

## Related fix: task lifecycle now treats cancelled turns as failures

Independent of the above, `backend/src/session-manager.ts` now treats ACP `stopReason ===
"cancelled"` (timeouts, or an explicit `session/cancel`) as a task failure — it resets the
task to `todo` instead of marking it `developed`. Before this fix, a task whose agent turn
was cut off mid-work (e.g. still debugging a broken `npm install`) could still get marked
successful and have a PR opened against unverified, possibly broken code, as long as some
files had changed and the git push succeeded. See commit "fix: treat cancelled agent turns
as task failures".

## Critical bug: `session/new` mcpServers entries need `env`, or kiro-cli rejects the whole request

Found 2026-08-04 while debugging why every local `KiroRunner.create()` call failed instantly
with `Error: ACP connection closed` (thrown from `@agentclientprotocol/sdk`'s `Connection.close`
when the underlying stdio stream ends with no matching response).

**Root cause:** kiro-cli 2.15.2's ACP schema defines `McpServer` as an **untagged enum** with three
variants (`McpServerHttp`, `McpServerSse`, `McpServerStdio`). `McpServerStdio` requires `env:
Array<EnvVariable>` as a **mandatory** field (see
`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`). Both `kiro-runner.ts` and
`worker/worker.js` always inject a hardcoded "verdict" MCP server entry into every `session/new`
call — and both omitted `env` entirely. Since the enum is untagged, serde can't match *any*
variant against `{name, command, args}` without `env`, so kiro-cli logs `ERROR ... Connection
error: Parse error: data did not match any variant of untagged enum McpServer` and exits
immediately (code 0, no stderr visible to the caller). The Node-side symptom is generic and
misleading: `Error: ACP connection closed`, with no indication of *why* the stream closed.

Confirmed by hand-driving the raw JSON-RPC protocol over stdio (bypassing the SDK entirely):
`initialize` always succeeded; `session/new` failed instantly whenever `mcpServers` contained an
entry without `env`, and succeeded the moment `env: []` was added.

**Fixed in this session** (commit pending) — added `env: []` to the verdict server entry in both:
- `backend/src/agent/kiro-runner.ts` (local/dev worker mode)
- `worker/worker.js` (`ensureAgentConfig`'s ACA/production worker path, the `session/new` call
  around line 1524)

Verified the fix end-to-end locally: `KiroRunner.create()` → real prompt → real model response
("PONG") → real credit usage reported (0.072 credits). Before the fix, every attempt died before
a single prompt could be sent.

**Production impact — this shipped as a real regression, not just a local dev issue.** Log
Analytics (`ContainerAppConsoleLogs_CL`, workspace `workspacesandboxforrm86f0`) shows the bug was
introduced by an AI dev-agent session while implementing **task 142** ("Add report_verdict MCP
tool for 'no further stage needed' signal, with diff cross-check") — the git diff in that
session's own tool-call logs shows it added the `mcpServers: [{name: "verdict", ...}]` block to
`worker.js`'s `session/new` call *without* `env`. Every worker session since that task merged has
been failing `session/new` immediately — no task work ever happens, the ACP session never comes
up, and per the existing "cancelled turns = failure" fix the task just silently resets to `todo`
and gets retried forever. This is very likely the explanation for unexplained task churn / tasks
that never seem to get worked despite the worker "running."

**If debugging a similarly mysterious instant worker failure in the future:** don't trust `Error:
ACP connection closed` at face value — it means the stdio stream ended, but says nothing about
why. Re-run kiro-cli directly with `acp -vv` (verbose) piped through manually-crafted JSON-RPC to
see the actual `ERROR chat_cli_v2::agent::acp::acp_agent` line, which does name the real
deserialization failure.

## Known gap: worker.js's spawnKiro() leaks PATs/WORKER_SECRET to the agent's shell

Found 2026-08-20 while designing the git-delivery MCP tools (tasks #585/#586) — checking
whether the agent could safely be given raw shell `git push` access surfaced that it
already effectively has equivalent exposure today, independent of that design.

`worker/worker.js`'s `spawnKiro()` spawns the `kiro-cli` child process (the one the agent's
shell tool runs inside) with `env: { ...process.env, KIRO_API_KEY, NO_COLOR: "1",
FORCE_COLOR: "0" }`. The `...process.env` spread forwards the ENTIRE worker process
environment to the agent, including `GITHUB_PAT`/`AZURE_DEVOPS_PAT` and `WORKER_SECRET`
(the shared secret authenticating this worker to the orchestrator's `/internal/worker`
WebSocket) — none of it is filtered. Any shell command the agent runs (`env`, `echo
$GITHUB_PAT`, etc.) can read these directly today.

This is worse than just "the agent could read it if it tried" — `extractToolOutputText()`
(which surfaces tool_call_update output into logs and, on failure, into `sendOutput()`)
does NOT call the file's own `redactSecrets()` helper, unlike the worker's own git calls
(`exec()`/`execFileArgs()`), which do. So a PAT/secret dumped by an agent's own command
could end up unredacted in the live session output stream and in
`ContainerAppConsoleLogs_CL`, not just in the ambient shell env.

**The fix pattern already exists in the codebase, just not applied here:**
`backend/src/agent/kiro-runner.ts`'s `KiroRunner.create()` (local/dev worker mode) builds
an explicit allowlist of env keys to forward (PATH/HOME/USER/TERM-type vars, `AWS_*`
prefix, `KIRO_API_KEY` specifically) and never spreads `process.env` wholesale. `worker.js`
should follow the same allowlist approach instead of the blanket spread.

Tracked as task #594 ("Worker's spawnKiro() leaks GITHUB_PAT/AZURE_DEVOPS_PAT/WORKER_SECRET
into agent's shell env") — not yet fixed as of this writing. If working on `worker.js`'s
`spawnKiro()` or on the git-delivery MCP tools (#585/#586) before #594 lands, keep in mind
the agent's shell already has ambient access to these secrets regardless of whether it also
gets new MCP tools — the MCP-over-shell design choice for #585/#586 avoids adding NEW
exposure, but doesn't fix this pre-existing one.

**Update 2026-08-20 — fixed, with one side effect to know about:** #594 was fixed and merged
(PR #70) via a new `worker/spawn-env.js` — an explicit allowlist plus a belt-and-suspenders
`BLOCKED_KEYS` list, matching the recommendation above. One resulting inconsistency worth
knowing about if debugging a "works locally, fails in production" issue: `kiro-runner.ts`
(local mode) still forwards the entire `AWS_*` prefix to the agent's shell, but
`spawn-env.js` (ACA/production mode) forwards none of it by design (`FORWARD_PREFIXES = []`,
with a comment that the worker container doesn't need AWS credentials for agent shell
commands). Before this fix both paths leaked everything, so they happened to agree by
accident; now they genuinely differ. Not a bug — nothing currently depends on AWS creds in
an agent's shell — but if a future task on some tab needs AWS tooling and only fails in the
ACA/production worker, this divergence is why. Add `"AWS_"` to `spawn-env.js`'s
`FORWARD_PREFIXES` if that ever becomes a real need.
