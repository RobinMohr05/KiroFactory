# Design Document

## Overview

This document specifies the technical design for migrating KiroFactory's persistence layer from
Azure SQL Server to Neo4j (AuraDB Free). It covers the graph data model, ID generation, the
concurrency-safe task-claiming redesign, task dependencies, the data-access layer architecture,
the one-time migration script, frontend changes, and the infrastructure/documentation cleanup.

Confirmed empirically against the live AuraDB Free instance (not assumed from docs): the instance
actually runs on the **Enterprise kernel** (`Neo4j Kernel 5.27-aura, edition: enterprise`).
Uniqueness constraints, property existence constraints, and node key constraints all work. This
removes what would otherwise be a real constraint on the data-integrity design below.

## Guiding principle for JSON-shaped columns

Per direction to favor the most future-proof modeling even where it's more work: every column that
currently holds a JSON-serialized value is converted to a native graph representation rather than
kept as an opaque string, using this rule:

- **Array of primitives** (strings/numbers) → native Neo4j list property.
- **ID array referencing another entity** → a real relationship, not a property at all.
- **Fixed-shape object, reused across entities** → its own node label, linked by relationship.
- **Fixed-shape object, small, always 1:1, frequently mutated** → flattened onto the parent
  node's own properties (avoids relationship-traversal overhead for something that changes on
  every tool call).
- **Array of objects** → ordered relationships (`position` property) to sub-nodes, recursing one
  level for any nested fixed-shape object; a further-nested arbitrary/unknown shape stays an
  opaque string on its sub-node (there's a limit to how far this pays off — an `unknown[]` blob
  with genuinely no fixed shape doesn't become "more future-proof" by force-fitting it into nodes).

The only two exceptions, both deliberate and noted inline below: `Session.agent` stays a
name-string (not a relationship) and `Session.currentTaskId` stays a scalar ID (not a
relationship) — both because the current app logic depends on their specific "soft reference,
falls back gracefully if missing" semantics, which a hard graph relationship would change.

## Architecture

```
Browser (vanilla HTML/CSS/JS)
    │ HTTP + WebSocket (unchanged)
    ▼
Express server (unchanged routes/middleware layer)
    │
    ▼
backend/src/db/*.ts + agent/task-claimer.ts   ← rewritten internals, same exported signatures
    │
    ▼
neo4j-driver (Bolt, neo4j+s://)
    │
    ▼
Neo4j AuraDB Free (845e53c6.databases.neo4j.io)
```

No route file, `session-manager.ts`, or `prompt-builder.ts` changes its imports — every function
in `db/*.ts` and `task-claimer.ts` keeps its current name, parameters, and return shape. Only the
SQL-vs-Cypher internals change. This is what lets the rewrite proceed file-by-file in parallel.

## Graph data model

### Node labels and properties

**`:User`**
| Property | Type | Notes |
|---|---|---|
| `id` | int | NODE KEY (unique + required) |
| `email` | string | UNIQUE constraint |
| `passwordHash` | string | bcrypt, unchanged |
| `kiroApiKeyEncrypted` | string | AES-256-GCM ciphertext, unchanged |
| `defaultGitProvider` | string \| null | |
| `credAzureDevOpsPat`, `credAtlassianApiToken`, `credAtlassianUsername`, `credAwsAccessKeyId`, `credAwsSecretAccessKey`, `credGithubPat` | string \| null | AES-256-GCM ciphertext, unchanged, opaque to Neo4j |
| `createdAt`, `updatedAt` | datetime | |

**`:Tab`**
| Property | Type | Notes |
|---|---|---|
| `id` | int | NODE KEY |
| `name` | string | no longer unique, matches current behavior |
| `repositoryUrl` | string \| null | |
| `gitProvider` | string \| null | |
| `columns` | list\<string\> | native list, was `columns_json` |
| `sortOrder` | int | |
| `createdAt` | datetime | |

Relationships: `(:User)-[:OWNS]->(:Tab)` (0 or 1 owner, matches nullable `user_id`);
`(:Tab)-[:HAS_MCP_CONFIG]->(:McpConfig)` (always present, matches `NOT NULL DEFAULT`).

**`:McpConfig`** (shared shape — used by `Tab` and optionally `Session`)
| Property | Type |
|---|---|
| `atlassian`, `azureDevops`, `awsApi`, `awsDocs` | boolean |

**`:Task`**
| Property | Type | Notes |
|---|---|---|
| `id` | int | NODE KEY |
| `title` | string | existence constraint |
| `priority` | int | 1-4, app-validated (no native range constraint) |
| `type` | string | `improvement`\|`bug`\|`feature`, app-validated |
| `state` | string | free-form pipeline stage, existence constraint, no enum (matches today) |
| `description` | string | |
| `files` | list\<string\> | native list, was `files` JSON |
| `origin` | string | `user`\|`ai`\|`user-assisted`, app-validated |
| `originRank` | int | **new** — precomputed 0/1/2/3 from `origin`, replaces the SQL `CASE` in `ORDER BY`; set/recomputed whenever `origin` is written |
| `branch`, `pullRequestUrl` | string \| null | |
| `createdAt`, `updatedAt` | datetime | |

Dropped: `retry_count`, `max_retries` (confirmed dead — nothing reads them). Not modeled:
`isBlocked` — **never stored**, always computed at query time from `DEPENDS_ON` traversal, so it
can never go stale relative to the actual dependency states.

Relationships: `(:Task)-[:IN_TAB]->(:Tab)` (1+, replaces `task_tabs`);
`(:Task)-[:DEPENDS_ON]->(:Task)` (0+, new).

**`:Agent`**
| Property | Type | Notes |
|---|---|---|
| `id` | int | NODE KEY |
| `name` | string | |
| `description`, `prompt` | string | |
| `tools`, `allowedTools`, `resources` | list\<string\> | native lists |
| `kind` | string | `editor`\|`inspector`, app-validated |
| `claimState`, `workingState`, `resolveState` | string | |
| `requiresTask` | boolean | |
| `createdAt`, `updatedAt` | datetime | |

Relationships: `(:User)-[:OWNS]->(:Agent)` (0 or 1); `(:Agent)-[:IN_TAB]->(:Tab)` (0+, replaces
`agent_tabs`); `(:Agent)-[:HAS_TOOLS_SETTINGS]->(:ToolsSettings)` (0 or 1, dynamic shape).

**`:ToolsSettings`** — arbitrary property map (mirrors the current arbitrary JSON object), written
via a parameterized `SET n += $map` so dynamic keys don't need to be enumerated in Cypher.

**`:Session`**
| Property | Type | Notes |
|---|---|---|
| `id` | int | NODE KEY |
| `name` | string | |
| `agent` | string | **kept as a name-string, not a relationship** — see exception note above |
| `status` | string | |
| `prompt` | string | |
| `interactive`, `loop` | boolean | |
| `runs`, `intervalSeconds`, `timeoutSeconds`, `sortOrder` | int | |
| `cwd` | string | |
| `model` | string \| null | |
| `activityType`, `activityDetail` | string \| null | **flattened** from `current_activity` object — small, fixed 2-key shape, changes on every tool call, not worth a relationship |
| `currentTaskId` | int \| null | **kept as a scalar, not a relationship** — see exception note above |
| `pinned`, `isPermanent`, `forceLocal` | boolean | |
| `createdAt`, `startedAt` | datetime | |

Not modeled: `output` (`OutputEntry[]`) — confirmed **not persisted today** (no `output` column
exists in `schema.sql`/`migrate.ts`; it's an in-memory-only buffer on the `ManagedSession` object
in `session-manager.ts`). No schema entry needed.

Relationships: `(:User)-[:OWNS]->(:Session)` (0 or 1); `(:Session)-[:IN_TAB]->(:Tab)` (0+, replaces
the `tab_ids` array — a real relationship instead of an embedded ID list is the clearest
"future-proof" win in this whole mapping); `(:Session)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig)`
(0 or 1, absent = inherit from tab); `(:Session)-[:HAS_MCP_SERVER {position: int}]->(:McpServerConfig)`
(0+, ordered); `(:Session)-[:HAS_RAW_MCP_SERVER {position: int}]->(:RawMcpServerConfig)` (0+, ordered).

**`:McpServerConfig`** (sub-node, ordered under `Session`)
| Property | Type | Notes |
|---|---|---|
| `name`, `command` | string | |
| `args` | list\<string\> | native list |
| `envNames`, `envValues` | list\<string\> | parallel arrays, flattened from `Array<{name,value}>` (same "small fixed-shape" flattening rule, applied one level deeper) |

**`:RawMcpServerConfig`** (sub-node, ordered under `Session`)
| Property | Type | Notes |
|---|---|---|
| `json` | string | kept opaque — type is literally `unknown[]`, no fixed shape exists to model |

**`:Settings`** — one node per key, e.g. `{key: 'registration_enabled', ...}`. The migration also
**fixes a live bug** found during investigation: `schema.sql` seeds the string `'true'` but
`migrate.ts` seeds `'0'`, and the read path only ever recognizes literal `"1"` as enabled — so a
fresh install's seed value is silently backwards. The Neo4j version normalizes this to a real
`registrationEnabled: boolean` property instead of carrying the string convention forward.

**`:Counter`** (infrastructure node, not a domain entity) — one per label needing IDs:
| Property | Type |
|---|---|
| `name` | string, NODE KEY (`'User'`, `'Tab'`, `'Task'`, `'Agent'`, `'Session'`) |
| `value` | int |

### Full relationship type list

```
(:User)-[:OWNS]->(:Tab | :Agent | :Session)
(:Task)-[:IN_TAB]->(:Tab)
(:Agent)-[:IN_TAB]->(:Tab)
(:Session)-[:IN_TAB]->(:Tab)
(:Task)-[:DEPENDS_ON]->(:Task)
(:Tab)-[:HAS_MCP_CONFIG]->(:McpConfig)
(:Session)-[:HAS_MCP_CONFIG_OVERRIDE]->(:McpConfig)
(:Agent)-[:HAS_TOOLS_SETTINGS]->(:ToolsSettings)
(:Session)-[:HAS_MCP_SERVER {position}]->(:McpServerConfig)
(:Session)-[:HAS_RAW_MCP_SERVER {position}]->(:RawMcpServerConfig)
```

### Schema bootstrap (replaces `migrate.ts`'s 26 incremental `ALTER`-based upgrades)

Neo4j is schema-optional — a node can start having a new property with no `ALTER TABLE`
equivalent needed. The entire incremental-upgrade machinery collapses to one idempotent bootstrap,
run on every startup exactly like today but far simpler:

```cypher
CREATE CONSTRAINT user_id_key     IF NOT EXISTS FOR (u:User)     REQUIRE u.id IS NODE KEY;
CREATE CONSTRAINT user_email_uniq IF NOT EXISTS FOR (u:User)     REQUIRE u.email IS UNIQUE;
CREATE CONSTRAINT tab_id_key      IF NOT EXISTS FOR (t:Tab)      REQUIRE t.id IS NODE KEY;
CREATE CONSTRAINT task_id_key     IF NOT EXISTS FOR (t:Task)     REQUIRE t.id IS NODE KEY;
CREATE CONSTRAINT agent_id_key    IF NOT EXISTS FOR (a:Agent)    REQUIRE a.id IS NODE KEY;
CREATE CONSTRAINT session_id_key  IF NOT EXISTS FOR (s:Session)  REQUIRE s.id IS NODE KEY;
CREATE CONSTRAINT counter_key     IF NOT EXISTS FOR (c:Counter)  REQUIRE c.name IS NODE KEY;
CREATE CONSTRAINT settings_key    IF NOT EXISTS FOR (s:Settings) REQUIRE s.key IS NODE KEY;

CREATE CONSTRAINT task_title_exists    IF NOT EXISTS FOR (t:Task) REQUIRE t.title IS NOT NULL;
CREATE CONSTRAINT task_state_exists    IF NOT EXISTS FOR (t:Task) REQUIRE t.state IS NOT NULL;
CREATE CONSTRAINT task_priority_exists IF NOT EXISTS FOR (t:Task) REQUIRE t.priority IS NOT NULL;

CREATE INDEX task_claim_order_idx IF NOT EXISTS FOR (t:Task) ON (t.state, t.priority, t.originRank, t.createdAt);
CREATE INDEX session_status_idx   IF NOT EXISTS FOR (s:Session) ON (s.status);
```

## Entity IDs (Requirement 4)

Atomic counter node per label, using Neo4j's default write-lock behavior — which is exactly what
we want here, unlike the claim path (a counter must serialize; that's the definition of correct):

```cypher
MERGE (c:Counter {name: $label})
ON CREATE SET c.value = 0
SET c.value = c.value + 1
RETURN c.value AS id
```

First call for a fresh label: `MERGE` creates the node at 0, the unconditional `SET` bumps it to
1, returns 1 — matching SQL `IDENTITY(1,1)`. During the one-time migration, each label's counter
is seeded to that label's **max existing imported ID** (not the next one) so the first post-migration
`SET ... + 1` correctly continues from above it, per Requirement 4.3.

## Task dependencies (Requirement 2)

### Cycle-safe dependency creation

```cypher
MATCH (a:Task {id: $fromId}), (b:Task {id: $toId})
WHERE a.id <> b.id
OPTIONAL MATCH path = (b)-[:DEPENDS_ON*1..50]->(a)
WITH a, b, path
WHERE path IS NULL
MERGE (a)-[:DEPENDS_ON]->(b)
RETURN a.id AS fromId, b.id AS toId
```

If `b` can already reach `a` via existing `DEPENDS_ON` edges, adding `a→b` would close a cycle —
detected by checking reachability from `b` to `a` *before* creating the edge, so the edge is never
written if it would form one. Self-dependency (`a.id = b.id`) is rejected by the `WHERE` guard.
The `*1..50` bound is a sanity ceiling (this app will never have chains anywhere near that deep);
it protects the path query from unbounded cost, not a real product constraint. If the `WHERE
path IS NULL` filters everything out, the write returns no rows — the calling code (`tasks.ts`)
treats zero rows as "rejected, cycle detected" and returns a 409-style API error naming the
conflicting task IDs.

### Blocked computation (never persisted, always computed at read time)

```cypher
MATCH (t:Task {id: $id})
OPTIONAL MATCH (t)-[:DEPENDS_ON]->(dep:Task)
WHERE dep.state <> 'done'
WITH t, collect({id: dep.id, title: dep.title}) AS blockers
RETURN t{.*}, size(blockers) > 0 AS isBlocked, blockers AS blockedBy
```

Applied the same way when listing a board's tasks (batched with `collect`/`WITH` over all tasks in
one query rather than N+1). The API returns both `isBlocked` (boolean, drives the card color) and
`blockedBy` (the actual blocking tasks' id/title, for a tooltip) — cheap to include since the
traversal already has the data, and much more useful than a bare boolean.

### Claim-query exclusion

The claim candidate query (below) adds:
```cypher
AND NOT EXISTS {
  MATCH (t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done'
}
```

## Concurrency-safe task claiming (Requirement 3)

This is the highest-risk piece of the whole migration. Neo4j's own docs describe implicit
write-locking on `SET` as depending on "direct dependency" analysis between the read and the
write — not precise enough to safely bet the correctness of this pipeline on. Instead of relying
on implicit lock timing, claiming uses an explicit **compare-and-swap retry loop**, which is
correct regardless of how the engine internally times its locks:

**Step 1 — read-only candidate list** (no lock semantics to reason about, it's a plain read):
```cypher
MATCH (t:Task {state: $claimState})
WHERE NOT EXISTS {
  MATCH (t)-[:DEPENDS_ON]->(dep:Task) WHERE dep.state <> 'done'
}
AND ($tabIds IS NULL OR EXISTS {
  MATCH (t)-[:IN_TAB]->(tab:Tab) WHERE tab.id IN $tabIds
})
RETURN t.id AS id
ORDER BY t.priority ASC, t.originRank ASC, t.createdAt ASC
LIMIT 20
```

**Step 2 — attempt claim per candidate, in order, each its own managed write transaction:**
```cypher
MATCH (t:Task {id: $id, state: $claimState})
SET t.state = $workingState, t.updatedAt = datetime()
WITH t
OPTIONAL MATCH (t)-[:IN_TAB]->(tab:Tab)<-[:OWNS]-(owner:User)
WITH t, collect({repositoryUrl: tab.repositoryUrl, userId: owner.id})[0] AS tabInfo
RETURN t{.*}, tabInfo
```

Loop through the 20 candidates in order; the first one whose `MATCH ... {state: $claimState}`
still holds (i.e., nobody else claimed it since Step 1) returns exactly one row — that's the
claimed task, loop stops. A candidate that's already been claimed by a concurrent caller returns
zero rows (the `MATCH` fails because `state` no longer equals `$claimState`) — move to the next
candidate. This is the explicit-code equivalent of "skip past a row someone else is holding"
instead of `READPAST`. If all 20 candidates are exhausted with no claim, return `null` — same
externally-visible behavior as today's "nothing available." 20 is a generous batch size for this
app's actual concurrency (a handful of pipeline sessions, not thousands); it is not a hard
guarantee against a pathological worst case, but that scale of contention doesn't exist here.

`resolveTask`/`resetTask`/`markTaskDone` map to plain single-`SET` managed writes — they were
never part of the locking-sensitive path (confirmed: no `UPDLOCK`/transaction in the current
implementation either), so this part translates mechanically. `notifyTaskAvailable()` /
`waitForTaskAvailable()` (the in-process `EventEmitter` + 5-minute fallback timer) carry over
completely unchanged — nothing about them is SQL-specific.

### Mandatory concurrency test (Requirement 3.6)

A mock-based test cannot prove this — mocks don't have real transactional/locking behavior. This
needs an integration test against the real AuraDB instance: seed N claimable tasks under a
dedicated, clearly-namespaced test `Tab` (e.g. `___concurrency-test___`), fire many concurrent
`claimTask()` calls via `Promise.all`, assert every claimed task went to exactly one caller and the
claimed set has no duplicates, then delete every node created for the test in an `afterAll`. Given
local dev already points at the same shared instance (accepted tradeoff), this test runs against
that same shared instance rather than a separate throwaway database — the tagging/cleanup is what
keeps it from polluting real data, not instance isolation.

## Data access layer

Same file paths, same exported function names/signatures as today — only internals change:

| File | Role change |
|---|---|
| `db/connection.ts` | `mssql` pool → `neo4j-driver` `Driver`. `isDbAvailable()` stays a cheap sync check (module-level flag updated by `tryConnect`/`verifyConnectivity`, no per-call network round trip). `tryConnect()` keeps its retry-then-give-up-without-throwing contract. `getPool()`-equivalent (`getDriver()`) keeps its throw-if-unavailable contract. `getPoolStats()` — **known gap, not carried over**: `neo4j-driver` has no public tarn-style pool introspection API equivalent to `mssql`'s; this returns `null`/is dropped, and the ACA workbook's "SQL Server Connection Pool Usage" panel is removed rather than faked. |
| `db/migrate.ts` | 26-step incremental `ALTER`-based runner → the constraint/index bootstrap above. Keeps the exported `runMigration()` name/behavior (idempotent, non-throwing, callable standalone). |
| `db/users.ts`, `tabs.ts`, `agents.ts`, `sessions.ts`, `settings.ts`, `credentials.ts` | Same exported functions, Cypher via `session.executeRead`/`executeWrite` (managed transactions — the driver auto-retries on transient/deadlock errors, which composes fine with the CAS loop above since each retry just re-runs the same idempotent conditional match). |
| `db/tasks.ts` | Adds `dependsOn`/`isBlocked`/`blockedBy` to `createTask`/`updateTask`/`getAllTasks`/`getTaskById`, plus the cycle-checked dependency-write helper above. |
| `agent/task-claimer.ts` | CAS-loop `claimTask`; mechanical `resolveTask`/`resetTask`/`markTaskDone`/`resetOrphanedTasks`; `notifyTaskAvailable`/`waitForTaskAvailable` unchanged. |

`GET /api/health` keeps its exact response shape (`{ status, database }`); `database` now
reflects Neo4j connectivity. `requireDb`/`isDbAvailable()`-gated 503 behavior on routes is
unchanged.

## One-time migration script (Requirement 5)

New standalone script, `backend/scripts/migrate-to-neo4j.ts` (manually invoked, not part of app
startup — parallel to existing `seed-agents.ts`/`seed-local-dev.ts`):

1. Connect to both the existing Azure SQL pool (`mssql`, read-only) and the Neo4j driver.
2. Run the schema bootstrap (constraints/indexes) first.
3. Import in dependency order, preserving every original ID and timestamp exactly:
   `users` → `tabs` (+ `OWNS` from owner, + `HAS_MCP_CONFIG` sub-node) → `agents` (+ `OWNS`,
   `IN_TAB`, `HAS_TOOLS_SETTINGS`) → `tasks` (+ `IN_TAB`; no `DEPENDS_ON` edges exist yet in the
   source, so this starts empty) → `sessions` (+ `OWNS`, `IN_TAB` from `tab_ids`,
   `HAS_MCP_CONFIG_OVERRIDE`, ordered `HAS_MCP_SERVER`/`HAS_RAW_MCP_SERVER`; coerce
   `status: 'running'` → `'stopped'` per Requirement 5.3) → `settings` (normalizing
   `registration_enabled` to a real boolean per the bug fix above).
4. Explicitly **skip** the `boards` table (confirmed dead: one placeholder row, zero FKs) and the
   `retry_count`/`max_retries` columns — logged explicitly so the operator sees they were skipped
   on purpose, not missed.
5. Seed each `Counter` node to the max imported ID for that label.
6. Print a per-entity table: rows read from SQL vs. nodes/relationships created in Neo4j, so parity
   is visually confirmable before treating cutover as done.
7. Any error aborts loudly with which entity/row it failed on — no silent partial success.

## Frontend changes (Requirement 2.6, plain JS/CSS — no framework, no TypeScript, confirmed)

**Card styling** (`app.js`'s `renderTaskCard`, `style.css`): add `card.dataset.blocked =
task.isBlocked ? 'true' : 'false'` alongside the existing `data-priority` attribute, plus a small
`<span class="badge badge-blocked">⛔ Blocked</span>`-style badge with a `title` attribute listing
`blockedBy` task titles — deliberately not color-only, both because it's better UX and because it
keeps the indicator legible for colorblind users (the brand skill's own accessibility guidance:
don't rely on color alone). New CSS var:

```css
--blocked-color: #E95718; /* orange-red, the literal midpoint between --ta-mango (#FF8700)
                              and --ta-rapid-red (#D22630) — chosen this way rather than an
                              arbitrary new hex, since it's derived from two already-approved
                              brand colors instead of introducing an unrelated one */
.task-card[data-blocked="true"] {
  background: color-mix(in srgb, var(--blocked-color) 8%, var(--card-bg));
  outline: 1px dashed var(--blocked-color);
}
```
applied as a background wash + outline layered on top of the existing priority accent bar (not
replacing it — a P1 task can also be blocked, both signals need to coexist), with a
`[data-theme="dark"]` override alongside the existing dark-mode block.

**Dependency editing** (`index.html`'s `taskForm`, `app.js`'s `showTaskForm`): a new `.form-group`
using a native `<select multiple>` (the exact existing pattern used for
`sessionTabsSelect`/`editSessionBoards` — populated from all other tasks, pre-selected to the
task's current `dependsOn`, read back via `Array.from(select.selectedOptions).map(o =>
Number(o.value))`), shown for both create and edit — `CreateTaskInput`/`UpdateTaskInput` both gain
an optional `dependsOn?: number[]`, mirroring how `tabIds` already works on `CreateTaskInput`
today. Cycle rejection surfaces as a form-level error message from the API's 409 response; no
client-side pre-filtering of the candidate list (the backend is the single source of truth for
"would this cycle"). No WebSocket/state-management changes needed at all — confirmed the existing
`task-updated` full-object-replace + full-board-rerender flow already carries any new `Task`
fields through with zero additional plumbing.

## Testing strategy

- **Concurrency test** for `claimTask` (Requirement 3.6) — integration test against the real
  AuraDB instance, described above.
- **Cycle-detection tests** for the dependency-write helper — direct dependency, transitive
  (A→B→C→A), and self-dependency all rejected; non-cyclic multi-dependency accepted.
- **`isBlocked`/`blockedBy` tests** — task with all-done dependencies is unblocked; task with any
  incomplete dependency is blocked and names it; task with no dependencies is unblocked.
- **Existing mock-based tests** (`sessions.test.ts`, `task-planner-image.test.ts`,
  `session-pin-reorder-fixes.test.ts`, `idle-loop-task-visibility-fixes.test.ts`) — updated to
  mock the `neo4j-driver` session/transaction shape in place of the `mssql` request/transaction
  shape they currently mock; test intent (what behavior is being asserted) is unchanged.
- **Migration script** — run once for real against the live data (143 tasks, 6 users, etc.) as
  part of executing this spec; the per-entity count table is the acceptance check, plus spot
  verification via `SHOW CONSTRAINTS`/sample `MATCH` queries against the AuraDB instance directly.

## Infrastructure changes (Requirement 8)

- `infra/modules/container-app.bicep`: replace `dbServer`/`dbDatabase`/`dbUser`/`dbPassword`/
  `dbPort`/`dbEncrypt`/`dbTrustServerCertificate` secure params + their `baseSecrets`/`baseEnv`
  entries with `neo4jUri`/`neo4jUsername`/`neo4jPassword`/`neo4jDatabase`.
- `infra/modules/vnet-peering.bicep`: **delete** — already confirmed unreferenced by any other
  file (dead even before this migration); AuraDB is reached over public Bolt (`neo4j+s://`), no
  VNET/private link involved on the Free tier.
- `infra/main.bicep`: remove the `enableVnet` param's Azure-SQL-specific wiring/comments. Flagging
  rather than assuming: confirm nothing else depends on that VNET before deleting the resource
  block outright (its only *stated* purpose was Azure SQL connectivity, but I want that verified
  against the live environment, not just the repo's comments, before removing infrastructure).
- `infra/deploy.sh` / `infra/deploy-app.sh`: remove the Azure SQL firewall-rule instructions and
  `DB_SERVER`/`DB_USER`/`DB_PASSWORD` required-env checks; add `NEO4J_URI`/`NEO4J_USERNAME`/
  `NEO4J_PASSWORD` checks instead.
- `infra/modules/monitoring.bicep` / `infra/workbook/kirofactory-dashboard.json`: remove the "SQL
  Server Connection Pool Usage" panel (no Neo4j equivalent, per the `getPoolStats()` gap above);
  keep/adapt the generic "Recent Database Connection Issues" grep-based panel since it's just
  string-matching log output, not mssql-specific.
- Per your decision, `rm-sandbox` Azure SQL Server is **not deleted** — kept running, unused, as a
  rollback safety net. `ARCHITECTURE.md` will describe Neo4j as the live database and note
  `rm-sandbox` as retained-but-inactive.

## Documentation changes

- `ARCHITECTURE.md`: §4 resource table (Neo4j AuraDB replaces the Azure SQL row, `rm-sandbox`
  annotated as retained/inactive), §5 config table (`NEO4J_*` replaces `DB_*`), §8 failure-mode
  table (swap the SQL-firewall row for a Neo4j-connectivity row), §9 data model (rewritten for the
  graph schema above), §11 "running locally" (rewritten for the shared-AuraDB-instance approach).
- `backend/README.md`: stack bullet, `db/` file table, "Database" section, and the full "Run
  entirely on localhost" section rewritten around connecting to the shared AuraDB instance instead
  of LocalDB (per your decision — option (a), no per-developer isolation, documented as an
  accepted tradeoff).
- Root `README.md`: full rewrite to match the actual current project (per your decision) — the
  `backend`/`frontend`/`worker` layout, `tabs` not `boards`, JWT auth, the ACA worker pipeline, and
  the Neo4j data layer once implemented — replacing the current doc's stale `server/`-directory,
  `boards`-API description.
- `SPEC.md`: left untouched per your decision ("the specs are irrelevant").
