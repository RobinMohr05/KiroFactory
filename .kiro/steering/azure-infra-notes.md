---
inclusion: always
---

# Azure Infrastructure — Actual Resource Names (learned by discovery)

The `infra/*.sh` scripts use placeholder defaults (`kirofactory-rg`, `kirofactory-logs`,
`kirofactory-orchestrator`) that do **not** match what is actually deployed. Don't trust
the script defaults — use these confirmed names instead, or re-verify with
`mcp_azure_mcp_group_resource_list` / `mcp_azure_mcp_group_list` if things may have moved.

## Confirmed deployment (as of Aug 2026)

- Subscription: `40978307-de4a-44a0-9d2a-e6d9ef2bb577` ("Visual Studio Professional-Abonnement",
  tenant TecAlliance). This is the only subscription visible via `mcp_azure_mcp_subscription_list`.
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
