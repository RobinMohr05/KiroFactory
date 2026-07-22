# KiroFactory Frontend

A dependency-free, static single-page web UI for KiroFactory. Plain HTML/CSS/JS — no framework,
no build step, no bundler.

> For the big picture (Azure resources, deploy, logs), see the root
> [`ARCHITECTURE.md`](../ARCHITECTURE.md). For the API it talks to, see
> [`../backend/README.md`](../backend/README.md).

---

## How it's served

The frontend is **not** deployed separately today. The backend Express server serves
`frontend/public/` as static files (same origin as the API). This keeps CORS trivial and means
the browser talks to the API and WebSocket on the same host.

Because it ships inside the backend image, **any frontend change requires rebuilding and
redeploying the backend image** (see root `ARCHITECTURE.md` §6).

---

## Files (`public/`)

| File | Purpose |
|------|---------|
| `index.html` | The main app shell: header, tab bar (boards), sub-views (Tasks/Sessions/Agents/Errors), and all modals (task, session, agent, tab, settings). |
| `app.js` | All client logic: REST calls, WebSocket connection, rendering the Kanban board, sessions, agents, errors, settings, and credential management. |
| `style.css` | Styling, light/dark theme (theme applied inline in `<head>` to avoid flash). |
| `favicon.svg` | Icon. |
| `login.html` | (served by backend) login/register page. |

There is no `package.json` build — `frontend/package.json` only has no-op `dev`/`build`
scripts so the workspace resolves.

---

## Client architecture (`app.js`)

- **Auth**: relies on the `kf_session` JWT cookie set by the backend. If the WebSocket closes
  with code `4001`, the client redirects to `/login.html`.
- **WebSocket**: connects to `wss://<host>/ws`. On `open`, live updates stop the polling loop.
  On close/error, it reconnects and falls back to polling. (The `/ws` path matters — ACA ingress
  must use `http`/HTTP-1.1 transport for WebSocket to work.)
- **Polling fallback**: `startPolling()` periodically calls the REST API so the board stays
  fresh even if the WebSocket can't connect.
- **Rendering**: `renderBoard()` (Kanban columns: To Do / In Progress / Developed),
  `renderBoardMembers()` (sessions/agents assigned to a board), plus per-view renderers for
  sessions, agents, and errors.

### Views
- **Tasks** — the Kanban board for the selected tab.
- **Sessions** — create/start/stop agent sessions, view live output, send follow-up prompts.
- **Agents** — manage Kiro agent definitions (prompt, tools, resources).
- **Errors** — agent errors reported by the backend error store.
- **Settings** — profile, password, Kiro API key, and encrypted service credentials
  (Azure DevOps PAT, Atlassian, AWS). Credential values are write-only from the browser's
  perspective — the API only reports whether each is set.

---

## Conventions

- Talks only to same-origin `/api/*` and `/ws`. No hardcoded hostnames.
- Guard DOM lookups before use — some elements only exist in certain views/modals. Missing
  elements should not throw (e.g. `renderBoardMembers` returns early if its container is absent).
- Keep it framework-free and buildless unless there's a strong reason to change.

---

## Local development

Run the backend (`npm run dev -w backend`) and open `http://localhost:3500`. The backend serves
these files directly, so just edit and refresh. In production, rebuild the backend image to ship
frontend changes.
