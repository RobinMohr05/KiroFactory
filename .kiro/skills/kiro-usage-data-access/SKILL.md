---
name: kiro-usage-data-access
description: How to read Kiro CLI/IDE usage, token, and credit data directly from local session files, IDE storage, and official billing/enterprise sources, and how to compute cost per agentic loop. Use when investigating Kiro cost/usage questions that are broader than KiroFactory's own worker/orchestrator credit tracking (e.g. auditing a developer's local Kiro CLI usage, or building a standalone cost report).
---

# Accessing Kiro Usage & Cost Data (without Langfuse)

How to read Kiro's token/credit/usage data straight from local files and official surfaces, and
how to compute **cost per agentic loop**.

> This is about Kiro CLI/IDE usage data in general — for how KiroFactory's own orchestrator and
> ACA worker track credits for *their* agent sessions, see the
> `kiro-usage-cost-tracking` steering doc instead. That's a different (narrower, ACP-stdio-based)
> mechanism than the file-based approach documented here.

> Verified against **Kiro CLI**, `schemaVersion 1.0.0` / `dataModelVersion 1` (Linux, 2026-07).
> Fields can change between Kiro versions — treat the schema as observed, not contractual.

---

## 0. Where the data lives (summary)

| Source | Scope | Format | Cost unit available |
|---|---|---|---|
| `~/.kiro/sessions/**/messages.jsonl` | Kiro **CLI** | JSONL event log | **credits per turn** (exact) |
| `~/.kiro/sessions/**/session.json` | Kiro **CLI** | JSON | metadata (model, mode) |
| `~/.kiro/logs/<ts>/*.log` | Kiro **CLI** | text logs | debugging only |
| IDE `globalStorage/state.vscdb` | Kiro **IDE** | SQLite | credits / invocations |
| IDE `.../dev_data/devdata.sqlite` | Kiro **IDE** | SQLite | token counts |
| Billing dashboard (`app.kiro.dev`) | Account | Web UI | credits (billed) |
| Enterprise per-user activity | Org | daily CSV | credits + overage |

Key fact: **Kiro bills in "credits" (a.k.a. invocations / spec-vibe requests), not raw tokens.**
The CLI session log records the exact credits charged per turn. Token input/output split is
**not** in the CLI log.

---

## 1. Kiro CLI — local session files (primary source)

### Location
- Root: `~/.kiro` (override with the `KIRO_HOME` environment variable).
- Sessions: `~/.kiro/sessions/<workspace-hash>/sess_<uuid>/`

```
~/.kiro/sessions/
└── 317cdb2c9db4c961/                 # workspace hash
    └── sess_76b01e2e-.../            # one chat session
        ├── session.json              # session metadata
        ├── messages.jsonl            # append-only event log  ← the data
        ├── snapshots/                # file checkpoints
        └── sub-executions/           # sub-agent runs
```

### `session.json`
```json
{
  "schemaVersion": "1.0.0",
  "dataModelVersion": 1,
  "id": "sess_76b01e2e-...",
  "title": "Analyse why cuka was not able to run ...",
  "agentMode": "vibe",
  "workspacePaths": ["/home/ckr/01_projects/cuka"],
  "createdAt": "2026-07-24T07:05:07.007Z",
  "lastModifiedAt": "2026-07-24T07:56:16.812Z",
  "modelId": "claude-opus-4.8",
  "autopilot": true,
  "effortLevel": "high",
  "status": "idle"
}
```

### `messages.jsonl`
One JSON object per line. Every record has the same envelope:

```json
{ "id": "<uuid>", "timestamp": "<ISO-8601 UTC>", "payload": { "type": "...", ... } }
```

The `payload.type` field determines the shape. An **agentic loop** = one `executionId`,
delimited by `turn_start` … `turn_end`, with a `usage_summary` carrying the credits.

Event lifecycle of one loop:
```
user  →  turn_start(executionId)  →  [ assistant | tool_call | tool_result
        | pending_interaction | interaction_resolved | sub_agent_* | session_metadata ]*
      →  usage_summary(executionId)  →  turn_end(executionId)
```

#### Event types (observed)

| `payload.type` | Carries `executionId` | Key fields |
|---|---|---|
| `user` | no (precedes turn) | `content`, `images`, `documents`, `_meta.traceparent` |
| `turn_start` | yes | — |
| `assistant` | yes | `content`, `operationType`, `reasoningModelId`, `reasoningSignature` |
| `tool_call` | yes | `toolName`, `args`, `toolCallId`, `actionType`, `kind`, `title`, `status` |
| `tool_result` | yes | `toolCallId`, `content`, `success` |
| `pending_interaction` | yes (=toolCallId) | `interactionType`, `question`, `options` |
| `interaction_resolved` | yes (=toolCallId) | `outcome`, `selectedOption` |
| `session_metadata` | yes | `key: "contextUsage"`, `value.usagePercentage` |
| `sub_agent_start` | via `parentExecutionId` | `subAgentName`, `subSessionId`, `prompt` |
| `sub_agent_complete` | via `parentExecutionId` | `subSessionId`, `response`, `status` |
| `usage_summary` | yes | **`promptTurnSummaries[]`**, `elapsedTime` (ms), `status` |
| `turn_end` | yes | `stopReason` |
| `session_start` | no | `agentType`, `content` (system prompt), `forcedRole` |
| `session_event` | in `context` | `category` (e.g. `session_pause`) |
| `tombstone` | no | `kind` (e.g. `summarization`), compaction metadata |

#### The cost record: `usage_summary`
```json
{
  "type": "usage_summary",
  "promptTurnSummaries": [
    {
      "unit": "credit",
      "unitPlural": "credits",
      "usage": 13.110335510281926,        // ← credits charged for THIS loop
      "usedTools": ["grep_search", "read_file", "execute_bash", ...]
    }
  ],
  "elapsedTime": 385806,                    // wall-clock ms (may include pauses)
  "status": "success",
  "executionId": "766508f9-4d77-4571-b0a9-cf687b3bd8ae"
}
```

`promptTurnSummaries[0].usage` is the **exact credit cost of one agentic loop**.

---

## 2. Recipe — cost per agentic loop

Algorithm:
1. Walk each `messages.jsonl`.
2. Remember the most recent `user.content` (the prompt).
3. On `turn_start`, open a loop keyed by `executionId`; attach the remembered prompt.
4. Accumulate `assistant` / `tool_call` counts (optional).
5. On `usage_summary`, record `promptTurnSummaries[0].usage` (credits), `usedTools`,
   `elapsedTime`.
6. On `turn_end`, record `stopReason`.
7. Read `modelId` / `agentMode` from the sibling `session.json`.

Minimal extractor (stdlib only):

```python
#!/usr/bin/env python3
import json, glob, os

ROOT = os.path.join(os.environ.get("KIRO_HOME", os.path.expanduser("~/.kiro")), "sessions")

def loops():
    for sess in sorted(glob.glob(os.path.join(ROOT, "*", "sess_*"))):
        try:
            meta = json.load(open(os.path.join(sess, "session.json")))
        except FileNotFoundError:
            meta = {}
        mfile = os.path.join(sess, "messages.jsonl")
        if not os.path.exists(mfile):
            continue
        cur, prompt = {}, None
        for line in open(mfile):
            line = line.strip()
            if not line:
                continue
            p = json.loads(line).get("payload", {}) or {}
            t, ex = p.get("type"), p.get("executionId")
            if t == "user":
                c = p.get("content")
                prompt = c if isinstance(c, str) else json.dumps(c)
            elif t == "turn_start" and ex:
                cur[ex] = {"executionId": ex, "session": os.path.basename(sess),
                           "model": meta.get("modelId"), "mode": meta.get("agentMode"),
                           "prompt": prompt, "credits": None, "tools": [], "ms": None,
                           "stop": None}
            elif ex in cur and t == "usage_summary":
                s = (p.get("promptTurnSummaries") or [{}])[0]
                cur[ex]["credits"] = s.get("usage")
                cur[ex]["tools"] = s.get("usedTools", [])
                cur[ex]["ms"] = p.get("elapsedTime")
            elif ex in cur and t == "turn_end":
                cur[ex]["stop"] = p.get("stopReason")
        for L in cur.values():
            if L["credits"] is not None:
                yield L

if __name__ == "__main__":
    total = 0.0
    print(f"{'credits':>8}  {'secs':>5}  {'tools':>5}  prompt")
    for L in loops():
        total += L["credits"]
        print(f"{L['credits']:8.2f}  {(L['ms'] or 0)/1000:5.0f}  {len(L['tools']):5}  "
              f"{(L['prompt'] or '')[:60].replace(chr(10), ' ')}")
    print(f"\nTOTAL credits: {total:.2f}")
```

Run:
```bash
python3 kiro_loops.py
# convert to CSV:  python3 kiro_loops.py > loops.txt
```

Aggregate ideas: sum credits per `session`, per day (`createdAt`), per model, or per
`usedTools` pattern. Everything you need is in the record above.

---

## 3. Kiro IDE — local storage (VS Code-based)

The IDE (a Code-OSS fork) stores data differently from the CLI, under the standard VS Code
`globalStorage` tree:

| OS | Base path |
|---|---|
| Linux | `~/.config/Kiro/User/globalStorage/` |
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/` |
| Windows | `%APPDATA%\Kiro\User\globalStorage\` |

Known files (community-derived, version-dependent — inspect before trusting):
- `state.vscdb` — SQLite (VS Code global state); holds **credit / invocation** counters.
- `kiro.kiroagent/dev_data/devdata.sqlite` — SQLite; holds **token** counts.
- `kiro.kiroagent/<session-hash>/*.chat` — per-session chat history (JSON).
- `logs/<session-timestamp>/` — application logs.

Inspect a DB:
```bash
sqlite3 "$HOME/.config/Kiro/User/globalStorage/state.vscdb" ".tables"
sqlite3 "$HOME/.config/Kiro/User/globalStorage/state.vscdb" \
  "SELECT key FROM ItemTable WHERE key LIKE '%credit%' OR key LIKE '%usage%';"
```
`state.vscdb` is a key/value store (`ItemTable(key, value)`), where `value` is usually JSON —
query the key, then parse the JSON blob.

---

## 4. Logs

`~/.kiro/logs/<runTimestamp>/`:
- `kiro.log` — main application log
- `mcp.log` — MCP server activity
- `powers.log` — Kiro "powers" activity

Useful for debugging tool errors and rate/limit messages; not a clean cost source.

---

## 5. Official / account-level sources (no file parsing)

- **Individual billing/usage:** `https://app.kiro.dev/settings` — shows billed credits.
- **Enterprise admin dashboard:**
  `https://kiro.dev/docs/cli/enterprise/monitor-and-track/dashboard/` — hourly usage metrics
  across the org.
- **Enterprise per-user activity (best official export):**
  `https://kiro.dev/docs/cli/enterprise/monitor-and-track/user-activity/` — opt-in daily **CSV**
  report with per-user credit + overage consumption.
- **CLI telemetry toggle:** `kiro-cli settings telemetry.enabled true|false`. On/off only — no
  customer-facing OTLP/metrics export endpoint.
- **ACP wire capture (CLI):** set `KIRO_ACP_RECORD_PATH=/path/to/trace.jsonl` to record the
  agent-client protocol traffic to JSONL (debugging; includes request/response flow).

---

## 6. Caveats & stability notes

- **Credits ≠ tokens.** The CLI log gives exact **credits** per loop; it does **not** expose
  input/output token counts. `session_metadata.value.usagePercentage` reports context-window
  fill %, not tokens.
- **`elapsedTime` is wall-clock** and can include idle time / `session_pause` events — don't
  treat it as pure compute time. Use **credits** as the cost signal.
- **Undocumented format.** `messages.jsonl` and the IDE SQLite schemas are internal and can
  change on Kiro updates. Pin behavior to `schemaVersion` / `dataModelVersion` in `session.json`
  and re-verify after upgrades.
- **CLI vs IDE differ.** The CLI uses JSONL session files (Section 1); the IDE uses the SQLite
  stores (Section 3). Check which client produced the data.
- **Sub-agents.** Nested runs appear as `sub_agent_start/complete` (linked via
  `parentExecutionId`) and under `sub-executions/`; their cost is already included in the parent
  turn's `usage_summary`.

---

## 7. Appendix — one-liners

```bash
# List all sessions with model + title
for f in ~/.kiro/sessions/*/sess_*/session.json; do
  python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['modelId'],'|',d.get('title','')[:60])" "$f"
done

# Total credits across every session
python3 - <<'PY'
import json, glob, os
tot=0.0
for f in glob.glob(os.path.expanduser("~/.kiro/sessions/*/sess_*/messages.jsonl")):
    for l in open(f):
        p=json.loads(l).get("payload",{}) if l.strip() else {}
        if p.get("type")=="usage_summary":
            tot+=(p.get("promptTurnSummaries") or [{}])[0].get("usage",0)
print(f"{tot:.2f} credits across all sessions")
PY
```
