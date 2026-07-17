# KiroFactory — Implementation Tasks

## Decisions Resolved

| Question | Answer |
|----------|--------|
| Frontend | Vanilla HTML/CSS/JS (no build step, like TecFactory) |
| Database | SQL Server (schema provided) |
| Port | 3500 |
| kiro-cli | Installed and authenticated |
| Real-time sync | Optimistic UI + WebSocket broadcast + DB change polling |

## Still Blocking

- [ ] **SQL Server connection details** — host, database name, auth method (Windows auth or SQL user/password?)

---

## Phase 1 — Core Server + ACP Integration

> All tasks in Phase 1 are **sequential** — each builds on the previous.

| # | Task | Depends on | Parallel? |
|---|------|-----------|-----------|
| 1.1 | Initialize Node.js project (package.json, tsconfig.json, ESM) | — | Start here |
| 1.2 | Install dependencies (express, ws, mssql, @agentclientprotocol/sdk) | 1.1 | No |
| 1.3 | Create src/types.ts — Shared TypeScript interfaces | 1.2 | Yes (with 1.4) |
| 1.4 | Create src/server.ts — Express + WebSocket server scaffold | 1.2 | Yes (with 1.3) |
| 1.5 | Create src/websocket-handler.ts — WebSocket message routing + broadcast | 1.4 | No |
| 1.6 | Create src/kiro-runner.ts — Port ACP client from TecFactory | 1.3 | Yes (with 1.4, 1.5) |
| 1.7 | Create src/session-manager.ts — Session lifecycle (create/start/stop/delete) | 1.5, 1.6 | No |
| 1.8 | Session CRUD REST API (POST/GET/DELETE /api/sessions) | 1.7 | No |
| 1.9 | Process manager (spawn/stop kiro-cli acp per session) | 1.7 | No (same file as 1.8) |
| 1.10 | WebSocket broadcast for session output/status | 1.5, 1.9 | No |

---

## Phase 2 — Database + Tasks/Boards API + Real-time Sync

> **Blocked by:** SQL Server connection details (one open question above).
> Phase 2 can start in parallel with Phase 1 tasks 1.6–1.10 once the DB connection is known.

| # | Task | Depends on | Parallel? |
|---|------|-----------|-----------|
| 2.1 | Create sql/schema.sql (boards, tasks, task_boards, Change Tracking) | 1.1 | Yes (with Phase 1) |
| 2.2 | Create src/db/connection.ts — mssql connection pool | 1.2 | Yes (with 1.3–1.6) |
| 2.3 | Create src/db/migrate.ts — Auto-run schema on startup | 2.2 | No |
| 2.4 | Create src/db/tasks.ts — Task CRUD queries | 2.3 | Yes (with 2.5) |
| 2.5 | Create src/db/boards.ts — Board CRUD queries | 2.3 | Yes (with 2.4) |
| 2.6 | Create src/routes/tasks.ts — /api/tasks REST endpoints | 2.4, 1.4 | No |
| 2.7 | Create src/routes/boards.ts — /api/boards REST endpoints | 2.5, 1.4 | Yes (with 2.6) |
| 2.8 | Task ↔ Board assignment endpoints | 2.6, 2.7 | No |
| 2.9 | WebSocket broadcast on every successful DB write | 2.6, 2.7, 1.5 | No |
| 2.10 | DB change detector (poll loop for external changes) | 2.3 | Yes (with 2.6–2.9) |
| 2.11 | Broadcast externally-originated changes to all clients | 2.9, 2.10 | No |

---

## Phase 3 — Browser UI: Board View

> **Blocked by:** Phase 2 tasks 2.6–2.9 (needs working REST API + WebSocket).
> Cannot run in parallel with Phase 2 (needs the API to talk to).

| # | Task | Depends on | Parallel? |
|---|------|-----------|-----------|
| 3.1 | Create public/index.html — Dashboard shell (tabs: Boards / Sessions) | 1.4 | Yes (with Phase 2) |
| 3.2 | Create public/style.css — Dark mode, Kanban layout, cards | 3.1 | Yes (with 3.3) |
| 3.3 | Create public/app.js — Client-side scaffold + WebSocket client | 3.1 | Yes (with 3.2) |
| 3.4 | Board selector / board management UI | 3.3, 2.7 | No |
| 3.5 | Kanban column layout (Todo / In Progress / Developed) | 3.2, 3.3, 2.6 | No |
| 3.6 | Task cards with priority/type/origin badges | 3.5 | No |
| 3.7 | Task creation form (with board assignment) | 3.4, 3.6 | No |
| 3.8 | Task editing panel (inline or modal) | 3.6 | Yes (with 3.7) |
| 3.9 | Drag-and-drop state changes (optimistic UI + REST write-through) | 3.6 | No |
| 3.10 | WebSocket handler: task-created/updated/deleted messages | 3.3, 2.9 | Yes (with 3.5–3.9) |
| 3.11 | Deduplication logic (pending ops tracking) | 3.9, 3.10 | No |
| 3.12 | Reconnect fallback (poll REST on WebSocket disconnect) | 3.10 | No |
| 3.13 | Periodic reconciliation (full board refresh every 30s) | 3.10 | Yes (with 3.11, 3.12) |
| 3.14 | Filtering and sorting controls | 3.6 | Yes (with 3.9–3.13) |

---

## Phase 4 — Browser UI: Sessions

> **Blocked by:** Phase 1 tasks 1.8–1.10 (needs working session API).
> Can run in parallel with Phase 3 (different tab in the UI).

| # | Task | Depends on | Parallel? |
|---|------|-----------|-----------|
| 4.1 | Session list view (status, name, agent, activity) | 3.1, 1.8 | Yes (with Phase 3) |
| 4.2 | Session creation form (agent, prompt, cwd, timeout, MCP servers) | 4.1 | No |
| 4.3 | Real-time log viewer per session | 4.1, 1.10 | Yes (with 4.2) |
| 4.4 | Start/Stop controls | 4.1, 1.9 | Yes (with 4.2, 4.3) |
| 4.5 | Follow-up prompt input for active sessions | 4.3 | No |
| 4.6 | Connection status indicator | 3.3 | Yes (anytime after 3.3) |

---

## Phase 5 — Integration + Polish

> **Blocked by:** Phases 3 and 4 complete.
> All items in Phase 5 are independent of each other (fully parallelizable).

| # | Task | Depends on | Parallel? |
|---|------|-----------|-----------|
| 5.1 | Agent sessions can create/update tasks via the API | 1.9, 2.6 | Yes |
| 5.2 | Session templates (save/load configurations) | 4.2 | Yes |
| 5.3 | Error boundary / crash recovery | 3.3 | Yes |
| 5.4 | Dark mode toggle | 3.2 | Yes |
| 5.5 | Keyboard shortcuts | 3.3 | Yes |
| 5.6 | Notifications (session complete, task state change) | 3.10, 4.3 | Yes |
| 5.7 | Unit tests (Vitest + supertest) | All phases | Last |

---

## Dependency Summary

```
Phase 1 (Server + ACP)  ─────────────────────────────────────────────►
     │                                                                 
     ├── 1.1 → 1.2 → 1.3 ──┐                                        
     │              └─ 1.4 ──┼── 1.5 → 1.7 → 1.8/1.9 → 1.10        
     │                       │                                        
     │              1.6 ─────┘                                        
     │                                                                 
Phase 2 (DB + API)  ──── can start after 1.2 ────────────────────────►
     │                                                                 
     ├── 2.1 (schema file, anytime)                                   
     ├── 2.2 → 2.3 → 2.4 ──┐                                        
     │              └─ 2.5 ──┼── 2.6/2.7 → 2.8 → 2.9 → 2.11        
     │                       │                                        
     │              2.10 ────┘                                        
     │                                                                 
Phase 3 (Board UI)  ──── blocked by 2.6+ ────────────────────────────►
     │                                                                 
     ├── 3.1 → 3.2/3.3 → 3.4/3.5 → 3.6 → 3.7/3.8/3.9 → 3.11      
     │                    └─ 3.10 ──────────────────────┘              
     │                                                                 
Phase 4 (Session UI)  ──── can run parallel to Phase 3 ──────────────►
     │                                                                 
     ├── 4.1 → 4.2/4.3/4.4 → 4.5                                    
     │                                                                 
Phase 5 (Polish)  ──── all independent, after 3+4 ───────────────────►
```

### Critical Path (longest sequential chain):

**1.1 → 1.2 → 1.4 → 1.5 → 1.7 → 1.8 → 2.6 → 2.9 → 3.5 → 3.6 → 3.9 → 3.11**

This is the minimum sequential work that gates the full board view with real-time sync.
