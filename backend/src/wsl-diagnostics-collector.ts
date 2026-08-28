/**
 * WSL / Docker Diagnostics Collector — always-on background capture of
 * host-machine WSL/Docker signal that never otherwise reaches the app's own
 * logs, for surfacing in the frontend's Errors panel "WSL/Docker Logs"
 * sub-tab.
 *
 * Why this exists: repeated investigations into local worker sessions dying
 * unexpectedly (see ARCHITECTURE.md §12 troubleshooting and
 * knowledge-base/knowledge/ for the incident history) kept hitting the same
 * wall — by the time a failure was reported, the evidence needed to diagnose
 * it (which process/signal actually killed a container, a kernel-level OOM
 * or driver crash trace) was already gone: Docker containers here run with
 * --rm (self-deleting logs on exit), `docker events`/`dmesg` don't persist
 * history retroactively, and manually starting a live capture *after* a
 * failure is reported is always too late to catch the failure that already
 * happened. The fix is to never stop watching in the first place.
 *
 * Captures three sources, each a long-lived child process piped through
 * `wsl.exe -d <distro> -- ...` (verified directly: `wsl.exe` proxies a
 * child's live stdout correctly for both of these, no batching/buffering
 * surprises):
 *   1. `docker events --format '{{json .}}'` — NDJSON stream of every
 *      container/network/image lifecycle event, critically including the
 *      `kill` action's `signal` attribute — this is the direct answer to
 *      "what killed my container and with what signal," which is exactly
 *      the evidence gap hit repeatedly today.
 *   2. `dmesg -w` (a.k.a. `dmesg --follow`) — WSL2 kernel ring buffer,
 *      follows live. Catches OOM kills, kernel driver crashes (e.g. the
 *      dxgkrnl/GPU passthrough crash found in a real investigation today),
 *      and other kernel-level faults that never surface anywhere else.
 *   3. Per-container `docker logs` capture, triggered by this module's own
 *      docker-events stream: when a `kirofactory-worker-*` or
 *      `kirofactory-mcp-proxy-*` container reports a `die` or `kill` action,
 *      immediately (best-effort, racing the container's own --rm cleanup)
 *      fetch its logs — this both duplicates and generalizes
 *      wsl-worker-spawner.ts's existing captureContainerLogs() (which only
 *      runs when session-manager.ts's own failure classification decides to
 *      call it), so a death this module's own classification logic doesn't
 *      catch (or hasn't been taught about yet) still gets its logs saved.
 *
 * All three sources feed one shared, capped ring buffer, broadcast live over
 * the WebSocket as they arrive (see websocket-handler.ts's broadcastToAll —
 * this is genuinely machine-level, not per-user, data).
 *
 * Lifecycle: started once at backend startup (see index.ts) IFF WSL local
 * worker mode is configured (isWslModeEnabled()) — this module must never
 * spawn wsl.exe processes on a machine that isn't using local mode at all
 * (e.g. production ACA-only deployments have no WSL distro to watch, and
 * would just accumulate spawn-failure noise). Each stream auto-restarts on
 * unexpected death (network hiccups, wsl.exe itself dying under the same
 * platform instability this module exists to observe) with a short backoff,
 * and is torn down cleanly on graceful shutdown.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { log, toErrorFields } from "./logger.js";
import { broadcastToAll } from "./websocket-handler.js";
import type { WslDiagnosticLine } from "./types.js";

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

const MAX_BUFFER_LINES = 2000;
const buffer: WslDiagnosticLine[] = [];
let nextLineId = 1;

function pushLine(line: Omit<WslDiagnosticLine, "id">): void {
  const withId: WslDiagnosticLine = { ...line, id: nextLineId++ };
  buffer.push(withId);
  if (buffer.length > MAX_BUFFER_LINES) {
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  }
  broadcastToAll({ type: "wsl-diagnostic-line", line: withId });
}

/** Returns a snapshot of the current buffer, for the initial-load REST endpoint. */
export function getDiagnosticBuffer(): WslDiagnosticLine[] {
  return [...buffer];
}

// ---------------------------------------------------------------------------
// Stream management — spawn, restart-on-death, teardown
// ---------------------------------------------------------------------------

interface ManagedStream {
  name: string;
  proc: ChildProcessByStdio<null, Readable, Readable> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const RESTART_BACKOFF_MS = 5_000;

let streams: ManagedStream[] = [];
let distroName = "kirofactory-docker";
let collectorRunning = false;

/**
 * Spawn one long-lived `wsl.exe -d <distro> -- <cmd...>` child, wiring its
 * stdout/stderr into `onLine`, and auto-restarting it after a short backoff
 * if it exits unexpectedly (any exit while the collector is still running is
 * "unexpected" — these commands are designed to run forever).
 */
function startManagedStream(
  name: string,
  cmd: string[],
  onLine: (rawLine: string) => void
): ManagedStream {
  const managed: ManagedStream = { name, proc: null, restartTimer: null, stopped: false };

  const spawnOnce = () => {
    if (managed.stopped) return;

    const proc = spawn("wsl.exe", ["-d", distroName, "--", ...cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    managed.proc = proc;

    let stdoutBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      const parts = stdoutBuf.split("\n");
      stdoutBuf = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) onLine(part);
      }
    });

    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
      const parts = stderrBuf.split("\n");
      stderrBuf = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) onLine(part);
      }
    });

    proc.on("error", (err) => {
      log.warn("wsl-diagnostics-stream-spawn-error", {
        component: "wsl-diagnostics",
        stream: name,
        ...toErrorFields(err),
        msg: `Failed to spawn diagnostics stream "${name}" — will retry`,
      });
      scheduleRestart();
    });

    proc.on("exit", (code, signal) => {
      managed.proc = null;
      if (managed.stopped) return; // intentional shutdown, don't restart
      log.warn("wsl-diagnostics-stream-exited", {
        component: "wsl-diagnostics",
        stream: name,
        code,
        signal,
        msg: `Diagnostics stream "${name}" exited unexpectedly (code: ${code}, signal: ${signal}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`,
      });
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (managed.stopped || managed.restartTimer) return;
    managed.restartTimer = setTimeout(() => {
      managed.restartTimer = null;
      spawnOnce();
    }, RESTART_BACKOFF_MS);
  };

  spawnOnce();
  return managed;
}

function stopManagedStream(managed: ManagedStream): void {
  managed.stopped = true;
  if (managed.restartTimer) {
    clearTimeout(managed.restartTimer);
    managed.restartTimer = null;
  }
  if (managed.proc) {
    managed.proc.kill();
    managed.proc = null;
  }
}

// ---------------------------------------------------------------------------
// docker events — parsing and per-container log capture hook
// ---------------------------------------------------------------------------

export interface DockerEventJson {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
}

/** Containers this collector cares about capturing logs for on death. */
export function isKiroFactoryContainer(name: string | undefined): boolean {
  if (!name) return false;
  return name.startsWith("kirofactory-worker-") || name.startsWith("kirofactory-mcp-proxy-");
}

/** Turn a parsed docker-events JSON object into a concise, human-readable one-liner. */
export function formatDockerEvent(ev: DockerEventJson): string {
  const name = ev.Actor?.Attributes?.name;
  const namePart = name ? ` ${name}` : "";
  if (ev.Type === "container" && ev.Action === "kill") {
    const sig = ev.Actor?.Attributes?.signal;
    return `container${namePart} killed (signal: ${sig ?? "unknown"})`;
  }
  if (ev.Type === "container" && ev.Action === "die") {
    const exitCode = ev.Actor?.Attributes?.exitCode;
    return `container${namePart} died (exit code: ${exitCode ?? "unknown"})`;
  }
  return `${ev.Type ?? "event"}${namePart} ${ev.Action ?? ""}`.trim();
}

function handleDockerEventLine(rawLine: string): void {
  let parsed: DockerEventJson;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    // Not JSON — likely a docker CLI warning/error printed to stderr
    // (e.g. transient connection issues to the daemon itself). Still
    // worth surfacing verbatim rather than dropping it silently.
    pushLine({ timestamp: new Date().toISOString(), source: "docker-events", text: rawLine });
    return;
  }

  const containerName = parsed.Actor?.Attributes?.name;
  pushLine({
    timestamp: new Date().toISOString(),
    source: "docker-events",
    text: formatDockerEvent(parsed),
    containerName,
  });

  // Best-effort: capture logs for a kirofactory container the moment it
  // dies/is killed, racing its own --rm self-deletion. See module doc
  // comment — this generalizes wsl-worker-spawner.ts's
  // captureContainerLogs(), which only runs when session-manager.ts's
  // failure classification already decided to call it.
  if (
    parsed.Type === "container" &&
    (parsed.Action === "die" || parsed.Action === "kill") &&
    isKiroFactoryContainer(containerName)
  ) {
    captureContainerLogOnDeath(containerName!);
  }
}

function captureContainerLogOnDeath(containerName: string): void {
  const proc = spawn("wsl.exe", ["-d", distroName, "--", "docker", "logs", "--tail", "200", containerName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
  proc.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
  proc.on("close", () => {
    if (!output.trim()) return; // container already fully removed, nothing captured
    pushLine({
      timestamp: new Date().toISOString(),
      source: "container-log",
      text: output.trimEnd(),
      containerName,
    });
  });
  proc.on("error", (err) => {
    log.warn("wsl-diagnostics-container-log-capture-failed", {
      component: "wsl-diagnostics",
      containerName,
      ...toErrorFields(err),
      msg: `Failed to capture logs for "${containerName}" on death`,
    });
  });
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

/**
 * Start the collector. Safe to call at most once per process — subsequent
 * calls are no-ops (guarded by collectorRunning) so a caller doesn't need to
 * track whether it already started this.
 */
export function startWslDiagnosticsCollector(distro: string): void {
  if (collectorRunning) return;
  collectorRunning = true;
  distroName = distro;

  log.info("wsl-diagnostics-collector-started", {
    component: "wsl-diagnostics",
    distroName,
    msg: `Starting always-on WSL/Docker diagnostics collector for distro "${distroName}"`,
  });

  streams = [
    startManagedStream(
      "docker-events",
      ["docker", "events", "--format", "{{json .}}"],
      handleDockerEventLine
    ),
    startManagedStream("dmesg", ["dmesg", "-w"], (rawLine) => {
      pushLine({ timestamp: new Date().toISOString(), source: "dmesg", text: rawLine });
    }),
  ];
}

/** Stop the collector and all its streams. Safe to call even if never started. */
export function stopWslDiagnosticsCollector(): void {
  if (!collectorRunning) return;
  collectorRunning = false;
  for (const stream of streams) {
    stopManagedStream(stream);
  }
  streams = [];
  log.info("wsl-diagnostics-collector-stopped", {
    component: "wsl-diagnostics",
    msg: "Stopped WSL/Docker diagnostics collector",
  });
}

/** For tests only — resets in-memory state between test cases. */
export function _resetForTests(): void {
  stopWslDiagnosticsCollector();
  buffer.length = 0;
  nextLineId = 1;
}
