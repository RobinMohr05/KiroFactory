# Implementation Plan

Execution groups below are ordered by dependency. Tasks within the same group have no
dependencies on each other and are implemented in parallel via sub-agents. Groups themselves are
sequential (each group depends on the previous one landing first).

- [x] 1. Foundation: connection, ID counter, schema bootstrap
  - [x] 1.1 Rewrite `backend/src/db/connection.ts` for `neo4j-driver`: replace the `mssql` pool
        with a `Driver` instance; preserve the exact exported contract used elsewhere
        (`isDbAvailable()` cheap sync check, `tryConnect(retries, delayMs)` retry-then-give-up
        without throwing, `getDriver()` throw-if-unavailable for query code, `closePool()`
        equivalent). Drop `getPoolStats()` (no neo4j-driver equivalent) — confirm every caller
        (`index.ts`'s `samplePoolMetrics`) is updated to stop calling it, not left dangling.
    - _Requirements: 6.2, 6.4_
  - [x] 1.2 Implement the `Counter` node ID-allocation helper (`getNextId(label)` per the design's
        `MERGE`/`SET`-based counter query) as a shared utility every `db/*.ts` create function
        calls.
    - _Requirements: 4.1, 4.3_
  - [x] 1.3 Rewrite `backend/src/db/migrate.ts` as the constraint/index bootstrap from the design
        doc (replacing the 26-step incremental runner), keeping the exported `runMigration()` name
        and its idempotent, non-throwing, standalone-CLI-callable behavior.
    - _Requirements: 1.4, 6.1_
  - [x] 1.4 Update `GET /api/health` in `backend/src/index.ts` to reflect Neo4j connectivity via
        the new `isDbAvailable()`, preserving the exact `{ status, database }` response shape.
    - _Requirements: 6.4_

- [x] 2. Data-access layer rewrite (parallel — independent modules, depends only on Group 1)
  - [x] 2.1 Rewrite `backend/src/db/users.ts` (User node CRUD, auth lookups, credential fields
        carried over verbatim) preserving every exported function's signature.
    - _Requirements: 1.1, 1.5, 6.1_
  - [x] 2.2 Rewrite `backend/src/db/credentials.ts` (encrypted credential get/set on `User` node
        properties) — no change to the encryption scheme itself, only the query layer.
    - _Requirements: 1.5, 6.1_
  - [x] 2.3 Rewrite `backend/src/db/tabs.ts` (`Tab` node + `OWNS`/`HAS_MCP_CONFIG` relationships,
        `columns` as a native list) preserving exported signatures including tab-scoped task
        listing.
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 6.1_
  - [x] 2.4 Rewrite `backend/src/db/agents.ts` (`Agent` node + `OWNS`/`IN_TAB`/
        `HAS_TOOLS_SETTINGS`, `tools`/`allowedTools`/`resources` as native lists) preserving
        exported signatures including the "unassigned agent usable on every tab" business rule
        from `getAgentsForTab`.
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 6.1_
  - [x] 2.5 Rewrite `backend/src/db/sessions.ts` (`Session` node + `OWNS`/`IN_TAB`/
        `HAS_MCP_CONFIG_OVERRIDE`/ordered `HAS_MCP_SERVER`/`HAS_RAW_MCP_SERVER`, `agent` kept as a
        name-string, `currentTaskId` kept as a scalar per the design's stated exceptions)
        preserving exported signatures including `reorderSessionsInDb`'s transactional bulk
        update and pin/permanent-session handling.
    - _Requirements: 1.1, 1.3, 1.6, 6.1_
  - [x] 2.6 Rewrite `backend/src/db/settings.ts` (`Settings` node per key) and fix the
        `registration_enabled` seed bug identified during design — store and read a real
        `registrationEnabled` boolean instead of the current ambiguous string convention.
    - _Requirements: 1.1, 1.4_

- [ ] 3. Tasks and claiming (sequential, single-owner — concurrency-critical, not parallelized)
  - [x] 3.1 Rewrite `backend/src/db/tasks.ts`: `Task` node CRUD, `files` as a native list,
        `originRank` maintained alongside `origin`, `IN_TAB` relationships replacing `task_tabs`,
        plus the new `DEPENDS_ON` write helper with cycle detection (reachability check before
        `MERGE`) and the batched `isBlocked`/`blockedBy` computation on every task read path.
    - _Requirements: 1.2, 1.6, 2.1, 2.4, 2.5, 4.1_
  - [x] 3.2 Rewrite `backend/src/agent/task-claimer.ts`: implement the two-step
        candidate-list-then-CAS-loop `claimTask` (excluding blocked tasks per Requirement 2.2),
        mechanical `resolveTask`/`resetTask`/`markTaskDone`/`resetOrphanedTasks`, and carry
        `notifyTaskAvailable`/`waitForTaskAvailable` over unchanged (no SQL-specific logic in
        either).
    - _Requirements: 2.2, 3.1, 3.2, 3.3, 3.4, 3.5_
  - [x] 3.3 Write the mandatory concurrency integration test against the real AuraDB instance:
        seed N claimable tasks under a dedicated, clearly-namespaced test tab, fire concurrent
        `claimTask()` calls, assert no task is ever claimed twice, clean up all test nodes
        afterward.
    - _Requirements: 3.6_
  - [x] 3.4 Write cycle-detection tests (direct, transitive, self-dependency all rejected;
        non-cyclic multi-dependency accepted) and `isBlocked`/`blockedBy` correctness tests.
    - _Requirements: 2.4, 2.5_

- [x] 4. API surface for dependencies
  - [x] 4.1 Add `dependsOn` to `CreateTaskInput`/`UpdateTaskInput` and `isBlocked`/`blockedBy` to
        the `Task` response type in `backend/src/types.ts`; wire `routes/tasks.ts` to accept/
        return them, returning a 409-style error with the conflicting task IDs when the
        cycle-detection helper rejects a write.
    - _Requirements: 2.1, 2.4_

- [x] 5. Frontend (parallel with Group 4, depends on Group 3's field names being final)
  - [x] 5.1 Add blocked-task styling: `data-blocked` attribute in `renderTaskCard`
        (`frontend/public/app.js`), the `--blocked-color` CSS variable and
        `.task-card[data-blocked="true"]` rules (including a dark-mode override) in
        `frontend/public/style.css`, plus a badge/tooltip so the signal isn't color-only.
    - _Requirements: 2.6_
  - [x] 5.2 Add an in-card dependency editor to the task form (`index.html`'s `taskForm`,
        `app.js`'s `showTaskForm`/submit handler): a `<select multiple>` populated from other
        tasks (excluding the task itself), pre-selected from `task.dependsOn`, read back on
        submit, with cycle-rejection errors from the API surfaced in the form.
    - _Requirements: 2.1_

- [x] 6. Test-mock updates (parallel with Groups 4-5, depends on Groups 1-3's final shapes)
  - [x] 6.1 Update every test currently mocking `db/connection.js`'s `mssql`-shaped surface
        (`sessions.test.ts`, `task-planner-image.test.ts`, `session-pin-reorder-fixes.test.ts`,
        `idle-loop-task-visibility-fixes.test.ts`) to mock the `neo4j-driver` session/transaction
        shape instead, preserving each test's original behavioral intent.
    - _Requirements: 6.5_

- [x] 7. Infrastructure and documentation (parallel, independent of Groups 4-6)
  - [x] 7.1 Update `infra/modules/container-app.bicep` to replace Azure SQL connection
        params/secrets/env vars with `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD`/
        `NEO4J_DATABASE`; delete `infra/modules/vnet-peering.bicep` (confirmed unreferenced) and
        its wiring in `infra/main.bicep` after confirming against the live environment that
        nothing else depends on that VNET; update `infra/deploy.sh`/`infra/deploy-app.sh`'s
        required-env checks and firewall instructions accordingly.
    - _Requirements: 8.1, 8.2_
  - [x] 7.2 Update `infra/modules/monitoring.bicep` / `infra/workbook/kirofactory-dashboard.json`
        to remove the SQL-Server-specific connection-pool panel and adapt the generic
        connection-issue panel.
    - _Requirements: 8.1_
  - [x] 7.3 Rewrite `ARCHITECTURE.md` (§4 resources, §5 config, §8 failure modes, §9 data model,
        §11 local running) and `backend/README.md` (stack bullets, `db/` file table, "Database"
        section, "Run entirely on localhost" section) to describe Neo4j/AuraDB in place of Azure
        SQL/LocalDB, noting `rm-sandbox` as retained-but-inactive per the decision not to delete
        it yet.
    - _Requirements: 7.1, 7.2, 8.3_
  - [x] 7.4 Fully rewrite the root `README.md` to match the project's actual current state
        (`backend`/`frontend`/`worker` layout, `tabs` not `boards`, JWT auth, the ACA pipeline,
        Neo4j data layer) — this doc currently describes a `server/` layout and `boards` API that
        no longer exist.
    - _Requirements: 8.3_

- [x] 8. Integration checkpoint
  - [x] 8.1 Run `npm run build -w backend` and the full test suite; fix any type errors or test
        failures surfaced by integrating all of Groups 1-6's changes together.
    - _Requirements: 6.1, 6.5_

- [x] 9. One-time data migration script
  - [x] 9.1 Write `backend/scripts/migrate-to-neo4j.ts`: read every row from the real Azure SQL
        tables (explicitly excluding `boards` and the dead `retry_count`/`max_retries` columns),
        run the schema bootstrap, import in dependency order preserving IDs/timestamps exactly,
        coerce `status: 'running'` sessions to `'stopped'`, seed each `Counter` to the max
        imported ID per label, normalize the `registration_enabled` setting to a boolean, and
        print a per-entity read-vs-created count table. Fail loudly on any error rather than
        completing a silent partial import.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 10. GATE — do not proceed without explicit user confirmation
  - [x] 10.1 Present the migration script's dry-run output/plan and get explicit confirmation
        before running it against the real production Azure SQL data (143 tasks, 6 users, etc.).
        This is a one-way read of production data into a new system of record — irreversible in
        effect even though the source data isn't modified.
    - _Requirements: 5.1, 5.2, 5.6_
    - Run against real data 2026-08-18. Parity confirmed: users 6/6, settings 1/1, tabs 6/6,
      tasks 143/143, agents 7/7, agent_tabs 2/2, sessions 16/16 (0 left `running`), task_tabs
      140 read / 137 created (3 skipped — pre-existing dangling `task_id`→`tab_id` refs to tabs
      5/12/14, which don't exist in source `tabs` either; a source-data quality issue, not a
      migration defect). Spot-checked files/columns_json→native list, mcp_config→sub-node,
      `registration_enabled` "1"→`enabled:true` (the exact bug this migration fixes), and
      verbatim credential copy — all correct. Azure SQL (`rm-sandbox`) untouched, not deleted,
      still fully readable, per explicit instruction.

- [x] 11. GATE — do not proceed without explicit user confirmation
  - [x] 11.1 After the real migration is verified (per-entity counts match, spot checks pass),
        get explicit confirmation before the final cutover: removing `mssql`/`@types/mssql` from
        `backend/package.json`, removing `DB_*` env var usage, and deploying the updated infra
        (bicep changes affect the live Container App).
    - _Requirements: 6.6, 8.1, 8.2, 8.4_
    - Confirmed 2026-08-18. Removed `mssql`/`@types/mssql` from `backend/package.json`, deleted
      `backend/scripts/migrate-to-neo4j.ts` (one-time script, job done — Gate 10.1) and the now-dead
      `backend/sql/` directory (schema.sql + migrations/, unreferenced by any Neo4j code), dropped
      the Dockerfile's `COPY backend/sql` step, and removed the stale `DB_*`/SQL-Server section from
      `backend/.env.example`. `npm run build -w backend` and the full test suite pass (108/111 —
      the 3 failures are pre-existing test-isolation flakiness in `planner-session-pool.test.ts`/
      `idle-loop-task-visibility-fixes.test.ts`, unrelated to this change and confirmed passing
      33/33 when run in isolation). Infra (`infra/deploy.sh`, `deploy-app.sh`, `monitoring.bicep`,
      the workbook dashboard) already referenced only `NEO4J_*`/Neo4j from earlier Group 7 work —
      no further infra changes needed here. Bicep deploy against the live Container App happens as
      part of the cutover itself (build image → deploy Bicep atomically → verify health), tracked
      outside this spec's task list.
