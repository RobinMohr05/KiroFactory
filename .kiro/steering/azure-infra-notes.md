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
