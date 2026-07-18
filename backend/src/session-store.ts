/**
 * Session Store — Persists session metadata to disk (sessions.json).
 *
 * Sessions are saved after every state change so they survive server restarts.
 * Output buffers are NOT persisted (too large / ephemeral) — only session config + status.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Session } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORE_PATH = resolve(import.meta.dirname, "../../sessions.json");

// ---------------------------------------------------------------------------
// Persisted session shape (no output buffer — too large for disk)
// ---------------------------------------------------------------------------

interface PersistedSession {
  id: string;
  name: string;
  agent: string;
  status: Session["status"];
  prompt: string;
  interactive: boolean;
  loop: boolean;
  runs: number;
  intervalSeconds: number;
  cwd: string;
  timeoutSeconds: number;
  model?: string;
  mcpServers?: Session["mcpServers"];
  boardIds?: number[];
  createdAt: string;
  startedAt?: string;
  currentTaskId?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all persisted sessions from disk.
 * Sessions that were "running" when the server died are marked "stopped"
 * (their processes no longer exist).
 */
export function loadSessions(): Session[] {
  if (!existsSync(STORE_PATH)) {
    return [];
  }

  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const persisted: PersistedSession[] = JSON.parse(raw);

    return persisted.map((p) => {
      // Sessions that were running when the server shut down
      // need to be reset — their processes are gone.
      const wasRunning = p.status === "running";
      const status: Session["status"] = wasRunning ? "stopped" : p.status;

      const session: Session & { __wasRunning?: boolean } = {
        id: p.id,
        name: p.name,
        agent: p.agent,
        status,
        prompt: p.prompt,
        interactive: p.interactive ?? true,
        loop: p.loop ?? false,
        runs: p.runs ?? 0,
        intervalSeconds: p.intervalSeconds ?? 10,
        cwd: p.cwd,
        timeoutSeconds: p.timeoutSeconds,
        model: p.model,
        mcpServers: p.mcpServers,
        createdAt: p.createdAt,
        startedAt: p.startedAt,
        currentTaskId: undefined, // Clear — no process is running
        output: [], // Output is not persisted
        currentActivity: undefined,
      };

      // Flag for session-manager to know this session should be auto-restarted
      if (wasRunning) {
        session.__wasRunning = true;
      }

      return session as Session;
    });
  } catch (err) {
    console.warn("[session-store] Failed to load sessions.json:", err);
    return [];
  }
}

/**
 * Save all sessions to disk. Call this after any session state change.
 */
export function saveSessions(sessions: Session[]): void {
  const persisted: PersistedSession[] = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    agent: s.agent,
    status: s.status,
    prompt: s.prompt,
    interactive: s.interactive,
    loop: s.loop,
    runs: s.runs,
    intervalSeconds: s.intervalSeconds,
    cwd: s.cwd,
    timeoutSeconds: s.timeoutSeconds,
    model: s.model,
    mcpServers: s.mcpServers,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    currentTaskId: s.currentTaskId,
  }));

  try {
    writeFileSync(STORE_PATH, JSON.stringify(persisted, null, 2), "utf-8");
  } catch (err) {
    console.error("[session-store] Failed to write sessions.json:", err);
  }
}
