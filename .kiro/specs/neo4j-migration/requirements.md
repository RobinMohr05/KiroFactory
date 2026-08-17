# Requirements Document

## Introduction

KiroFactory currently persists all application state (users, tabs, tasks, agents, sessions,
settings, and their relationships) in Azure SQL Database (`rm-sandbox.database.windows.net/TecFactory`),
accessed via the `mssql` driver. This spec covers a full migration of that persistence layer to
Neo4j (AuraDB Free), with Azure SQL removed entirely afterward.

Two things motivate the switch:
1. **Cost** — moving off a paid Azure SQL instance onto AuraDB Free.
2. **Task ordering** — the product wants tasks to declare dependencies on other tasks (task B
   can't be worked until task A is done). This is naturally a graph problem (dependency edges,
   transitive "is this blocked" checks) and awkward in SQL (recursive CTEs), so it's the one part
   of the current schema that actually benefits from a graph database — the rest of the schema
   (users, tabs, agents, sessions) is plain relational data with no inherent graph shape.

This is a **full migration**, not a side-by-side evaluation: Azure SQL and the `mssql` driver are
removed from the codebase, infra, and docs once the migration is complete. Cutover is **big-bang**
via a one-time export/import script — no dual-write phase, no gradual rollout. AuraDB Free's
operational risk profile (72-hour auto-pause on inactivity, auto-delete after 30 days paused) has
been explicitly accepted for this application.

### Out of scope for this spec
- A visual UI for managing task dependencies (drag arrows between cards, graph view). A basic
  way to set dependencies (e.g. a list of task IDs) is in scope; richer visualization is deferred
  and will be scoped later.
- Fixing the already-stale root `README.md` and `SPEC.md` — both predate this effort, describe a
  `server/` layout and `boards` API that no longer exist, and are broken independently of this
  migration. Not touched here.
- Any change to horizontal scaling of the orchestrator process itself (the in-process
  `EventEmitter`/task-count-cache in `task-claimer.ts` is per-instance today and remains so).
- Any change to the credential encryption scheme (AES-256-GCM via `crypto.ts`). Encrypted values
  are opaque strings from the database's point of view and carry over unchanged.

## Requirements

### Requirement 1: Graph data model

**User Story:** As a developer, I want the existing relational schema represented as an equivalent
Neo4j graph model, so that every current feature (auth, tasks, tabs, agents, sessions, credentials,
settings) continues to work after the migration.

#### Acceptance Criteria

1. WHEN the migration is complete THEN THE SYSTEM SHALL represent each of the following current
   entities as a Neo4j node label with equivalent properties: `User`, `Tab`, `Task`, `Agent`,
   `Session`, and a `Settings` node (or single node per key) for the current `settings` key/value
   table.
2. WHEN the migration is complete THEN THE SYSTEM SHALL represent the current `task_tabs` and
   `agent_tabs` many-to-many junction tables as native Neo4j relationships (e.g.
   `(:Task)-[:IN_TAB]->(:Tab)`, `(:Agent)-[:IN_TAB]->(:Tab)`) rather than junction nodes or
   embedded ID-array properties.
3. WHEN the migration is complete THEN THE SYSTEM SHALL represent ownership relationships
   currently expressed via nullable `user_id` foreign keys (`tabs.user_id`, `agents.user_id`,
   `sessions.user_id`) as relationships (e.g. `(:User)-[:OWNS]->(:Tab)`), preserving the current
   nullability (a `Tab`/`Agent`/`Session` may have no owner).
4. WHEN the migration is complete THEN THE SYSTEM SHALL preserve every currently-enforced data
   rule that has no native Neo4j equivalent (the `priority BETWEEN 1 AND 4`, `type IN (...)`,
   `origin IN (...)`, `kind IN (...)` CHECK constraints, and the `users.email` uniqueness
   constraint) at the application layer or via Neo4j property existence/uniqueness constraints
   where supported.
5. WHEN the migration is complete THEN THE SYSTEM SHALL continue to store the six per-user
   encrypted credential values and the encrypted Kiro API key as opaque string properties on the
   `User` node, with no change to how they are encrypted, decrypted, or queried.
6. IF a piece of data stored as a JSON string today (e.g. `tasks.files`, `tabs.columns_json`,
   `sessions.mcp_servers`) has no query or filter ever run against its internal structure THEN
   THE SYSTEM MAY store it as a native Neo4j list/array property instead of a JSON string,
   at the implementer's discretion, provided existing read/write code is updated accordingly.
7. WHEN the migration is complete THEN THE SYSTEM SHALL NOT carry over the `boards` table (a
   confirmed-dead leftover from a prior rename, unreferenced by any foreign key, containing a
   single placeholder row) or the dead `tasks.retry_count` / `tasks.max_retries` columns (confirmed
   unread by any code path — retry logic is in-memory only, in `session-manager.ts`).

### Requirement 2: Task dependency ordering

**User Story:** As a user, I want to declare that a task depends on one or more other tasks, so
that dependent tasks aren't picked up by an agent before their prerequisites are done.

#### Acceptance Criteria

1. WHEN a task is created or edited THEN THE SYSTEM SHALL allow specifying zero or more other
   tasks it depends on, stored as a directed relationship (e.g. `(:Task)-[:DEPENDS_ON]->(:Task)`).
2. WHEN the task claim query runs THEN THE SYSTEM SHALL exclude any task that has at least one
   `DEPENDS_ON` relationship to a task whose state is not the pipeline's terminal "done" state.
3. WHEN a task's dependencies are all in the terminal "done" state (or it has none) THEN THE
   SYSTEM SHALL treat that task as normally claimable, subject to the existing priority/origin/
   creation-time ordering.
4. WHEN a user attempts to create a dependency relationship that would introduce a cycle (directly
   or transitively, e.g. A depends on B depends on A) THEN THE SYSTEM SHALL reject the write and
   return an error identifying the cycle, without creating the relationship.
5. WHEN a task is blocked by one or more incomplete dependencies THEN THE SYSTEM SHALL indicate
   this to the frontend (e.g. an `isBlocked` flag or equivalent derived field) so the board can
   render it distinctly.
6. WHEN the board renders a task that is blocked by incomplete dependencies THEN THE FRONTEND
   SHALL display that task card in a distinct shade of orange-red, visually distinguishable from
   normal task cards.
7. IF a blocked task's dependencies later become fully done THEN THE SYSTEM SHALL reflect the
   task as unblocked (normal appearance, normally claimable) without requiring a manual refresh
   beyond the app's existing update mechanism (WebSocket broadcast on task changes).

### Requirement 3: Concurrency-safe task claiming

**User Story:** As the platform operator, I want multiple concurrent agent sessions to be able to
claim tasks from the same board simultaneously without ever claiming the same task twice, so that
the multi-stage agent pipeline (developer → code-reviewer → qa-improvement) continues to work
correctly under concurrent load after the migration.

#### Acceptance Criteria

1. WHEN two or more sessions attempt to claim a task from the same claimable state at
   approximately the same time THEN THE SYSTEM SHALL guarantee that no two sessions are ever
   returned the same task.
2. WHEN a session claims a task THEN THE SYSTEM SHALL select the highest-priority eligible
   candidate using the existing ordering rules (priority ascending, then origin — `user` before
   `user-assisted` before `ai` before other — then creation time ascending), consistent with
   today's behavior, and additionally excluding tasks blocked per Requirement 2.
3. WHEN a claim attempt targets a candidate task that another session has already claimed in the
   interim THEN THE SYSTEM SHALL detect the conflict and move on to the next eligible candidate
   rather than blocking indefinitely or double-claiming.
4. WHEN no eligible task is available for a claim attempt THEN THE SYSTEM SHALL return no task,
   matching current behavior (the caller then waits for a "task available" notification).
5. WHEN a task is resolved, reset, or claimed THEN THE SYSTEM SHALL preserve the current
   `notifyTaskAvailable()` / `waitForTaskAvailable()` wake-up behavior (event-driven with a
   fallback timer) so idle loop sessions still wake promptly when new work appears.
6. WHEN the claiming logic is implemented THEN it SHALL be covered by an automated concurrency
   test that runs many simultaneous claim attempts against a small set of claimable tasks and
   asserts that every claimed task was returned to exactly one caller.

### Requirement 4: Entity identifiers

**User Story:** As a developer, I want every entity (task, tab, agent, user, session) to keep a
stable, human-readable integer identifier, so that existing conventions that embed these IDs
(git branch names, PR titles, log messages, UI displays like "Task #142") keep working without
changes.

#### Acceptance Criteria

1. WHEN a new entity of any migrated type is created THEN THE SYSTEM SHALL assign it a unique
   integer ID atomically as part of the creation write, with no possibility of two entities of the
   same type receiving the same ID under concurrent creation.
2. WHEN the one-time data migration runs THEN THE SYSTEM SHALL preserve the existing integer IDs
   from Azure SQL for all migrated rows, so that references embedded in existing data (e.g.
   `task_tabs` links, existing git branches following `[type]/#[id]_[slug]`, existing PR URLs/
   titles) remain valid and correctly correlated after migration.
3. WHEN new entities are created after the migration THEN THE SYSTEM SHALL continue numbering
   from above the highest previously-existing ID for that entity type (no reuse, no restart at 1).

### Requirement 5: One-time data migration

**User Story:** As the platform operator, I want a single script that exports all current data
from Azure SQL and imports it into the new Neo4j instance, so that the cutover is a one-time,
verifiable event rather than a long-running dual-write process.

#### Acceptance Criteria

1. WHEN the migration script is run THEN THE SYSTEM SHALL read every row from all real tables in
   the current Azure SQL database (`users`, `tabs`, `tasks`, `task_tabs`, `agents`, `agent_tabs`,
   `sessions`, `settings`) and explicitly exclude the confirmed-dead `boards` table.
2. WHEN the migration script imports data THEN THE SYSTEM SHALL create the corresponding Neo4j
   nodes and relationships per the model defined in Requirement 1, preserving original IDs,
   timestamps, and all column values (including encrypted credential strings, verbatim).
3. WHEN the migration script imports a session row whose `status` is `running` THEN THE SYSTEM
   SHALL coerce it to `stopped` on import, consistent with the existing precedent that a live
   process cannot be resumed across a persistence-layer switch.
4. WHEN the migration script finishes THEN THE SYSTEM SHALL report a per-entity-type count of
   rows read from Azure SQL versus nodes/relationships created in Neo4j, so the operator can
   visually confirm parity before treating the cutover as complete.
5. WHEN the migration script encounters an error partway through THEN THE SYSTEM SHALL fail
   loudly with enough detail to identify what was and wasn't imported, rather than silently
   completing a partial migration.
6. WHEN the cutover is confirmed complete THEN THE SYSTEM SHALL treat Neo4j as the sole system of
   record — no ongoing dual-write or sync back to Azure SQL is implemented.

### Requirement 6: Application data layer migration

**User Story:** As a developer, I want the backend's data-access layer to talk to Neo4j instead
of Azure SQL, so that every existing feature (auth, task board, agents, sessions, credentials,
settings, health checks) works identically from the user's perspective.

#### Acceptance Criteria

1. WHEN the migration is complete THEN THE SYSTEM SHALL replace every function in
   `backend/src/db/*.ts` and `backend/src/agent/task-claimer.ts` that currently issues `mssql`
   queries with an equivalent implementation using the Neo4j driver, preserving each function's
   existing exported signature (parameters and return shape) wherever practical, so calling code
   in routes, `session-manager.ts`, and `prompt-builder.ts` does not need to change.
2. WHEN the migration is complete THEN THE SYSTEM SHALL preserve the current connection-health
   contract used throughout the app: a cheap synchronous "is the database available" check, a
   connect-with-retry path that never throws, and a "get a working handle or throw" path for
   query code — regardless of which driver backs it.
3. WHEN the database is unavailable THEN THE SYSTEM SHALL continue to return `503` from routes
   currently guarded by `requireDb` / `isDbAvailable()`, matching current behavior.
4. WHEN the migration is complete THEN THE SYSTEM SHALL update `GET /api/health` to report the
   Neo4j connection status in place of the current Azure SQL status, preserving the existing
   response shape (`{ status, database }`).
5. WHEN the migration is complete THEN THE SYSTEM SHALL update every automated test that currently
   mocks `db/connection.js`'s `mssql`-shaped surface (`getPool`, `sql`, `isDbAvailable`) to mock
   the equivalent Neo4j-driver-shaped surface, so the existing test suite continues to pass.
6. WHEN the migration is complete THEN THE SYSTEM SHALL remove the `mssql` and `@types/mssql`
   packages from `backend/package.json`, and remove all `DB_SERVER` / `DB_DATABASE` / `DB_USER` /
   `DB_PASSWORD` / `DB_PORT` / `DB_ENCRYPT` / `DB_TRUST_SERVER_CERTIFICATE` environment variable
   usage from the codebase.

### Requirement 7: Local development environment

**User Story:** As a developer working on KiroFactory, I want a documented way to run the app
locally against Neo4j, so that local development is possible without needing Azure access.

#### Acceptance Criteria

1. WHEN a developer sets up KiroFactory locally THEN THE SYSTEM SHALL document connecting to the
   shared AuraDB Free instance (the same one used for the cutover) as the supported local
   development path, replacing the current SQL Server Express LocalDB instructions.
2. WHEN the local development documentation is updated THEN THE SYSTEM SHALL note that local
   development data is shared across everyone using that instance (no per-developer isolation),
   as an explicitly accepted tradeoff.
3. WHEN a developer runs the existing local seed scripts (or their post-migration equivalents)
   THEN THE SYSTEM SHALL create the same baseline local-dev data (e.g. the `local-dev@example.com`
   test user) in Neo4j that it previously created in LocalDB.

### Requirement 8: Azure SQL decommissioning

**User Story:** As the platform operator, I want every reference to Azure SQL removed from the
codebase, infrastructure, and actively-maintained documentation once the migration is verified,
so that there's no confusion about which database is authoritative and no unused resources are
left running.

#### Acceptance Criteria

1. WHEN the migration is verified complete THEN THE SYSTEM SHALL remove Azure SQL connection
   parameters and secrets (`dbServer`, `dbDatabase`, `dbUser`, `dbPassword`, `dbPort`, `dbEncrypt`,
   `dbTrustServerCertificate`) from `infra/modules/container-app.bicep`, replacing them with
   whatever connection configuration Neo4j requires.
2. WHEN the migration is verified complete THEN THE SYSTEM SHALL remove or update
   `infra/modules/vnet-peering.bicep`, `infra/deploy.sh`'s Azure SQL firewall-rule instructions,
   and `infra/deploy-app.sh`'s `DB_SERVER`/`DB_USER`/`DB_PASSWORD` requirement checks, since
   VNET connectivity to Azure SQL will no longer be needed.
3. WHEN the migration is verified complete THEN THE SYSTEM SHALL update `ARCHITECTURE.md` and
   `backend/README.md` (the actively-maintained, currently-accurate docs) to describe the Neo4j
   data model and connection setup in place of the Azure SQL sections, including the resource
   table in `ARCHITECTURE.md` §4 and the "Running locally without Azure or Docker" section.
4. WHEN the migration is verified complete THEN THE SYSTEM SHALL decommission the `rm-sandbox`
   Azure SQL Server resource (or explicitly confirm with the operator that it should be kept
   around temporarily as a rollback safety net before deletion).
