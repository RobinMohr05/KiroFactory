/**
 * KiroRunner — ACP Client Wrapper
 *
 * Spawns `kiro-cli acp` as a subprocess and communicates over NDJSON/stdio
 * using the Agent Client Protocol.
 *
 * Adapted from TecFactory's kiro-runner.ts for the Vibecode Heaven project.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { log, toErrorFields } from "../logger.js";

// ---------------------------------------------------------------------------
// Types (avoid hard dependency on @agentclientprotocol/sdk at import time)
// ---------------------------------------------------------------------------

/** A streaming session update chunk from the ACP session. */
export interface SessionUpdateChunk {
  sessionUpdate?: string;
  content?: { text?: string };
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface KiroRunnerOptions {
  /** Agent name from .kiro/agents/ (optional — omit for agentless sessions) */
  agent?: string;
  /** Working directory for the kiro-cli process */
  cwd: string;
  /** Optional model override */
  model?: string | null;
  /** Optional MCP servers to inject at session creation (stdio only) */
  mcpServers?: McpServerEntry[];
  /**
   * Optional raw MCP server entries to inject directly into the session/new
   * mcpServers payload. These bypass the McpServerEntry type and are included
   * as-is — use for HTTP-type servers or any shape that matches the ACP schema.
   */
  rawMcpServers?: unknown[];
  /** Optional per-user Kiro API key (takes precedence over process.env.KIRO_API_KEY) */
  kiroApiKey?: string;
}

// ---------------------------------------------------------------------------
// Windows short-path helper
// ---------------------------------------------------------------------------

function getShortPath(longPath: string): string {
  if (process.platform !== "win32") return longPath;
  if (!longPath.includes(" ")) return longPath;

  try {
    const result = execSync(
      `cmd /c for %I in ("${longPath}") do @echo %~sI`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (result && !result.includes(" ") && !result.includes("\n")) {
      return result;
    }
  } catch {
    /* fall through */
  }

  return longPath;
}

/**
 * Reject a persisted `cwd` that was captured from a Linux container
 * environment (e.g. "/app" — the production/Docker WORKDIR — or the ACA
 * worker's "/workspace") before it ever reaches `path.resolve()`.
 *
 * `path.resolve()` does NOT error on a POSIX-style absolute path on win32 —
 * it silently reinterprets a leading "/" as relative to the current drive
 * (e.g. "/app" -> "C:\app"). A session whose `cwd` was persisted while the
 * server ran in a container and is later reused on a local Windows machine
 * would therefore NOT fail cleanly: it would spawn kiro-cli into whatever
 * "C:\app" happens to be — nonexistent (caught by the existsSync check
 * below), or worse, some unrelated directory that happens to already exist
 * there, in which case the existsSync check never fires and the agent is
 * silently pointed at the wrong working tree instead of the real project.
 * This must run on the raw, pre-resolve string.
 */
export function assertNotContainerPathOnWindows(rawCwd: string): void {
  if (process.platform === "win32" && rawCwd.startsWith("/")) {
    throw new Error(
      `Session working directory "${rawCwd}" is a container-style path (e.g. from a ` +
        `production ACA/Docker run) and cannot be used on this Windows machine — resolving ` +
        `it would silently produce an unrelated drive-root path like "C:\\${rawCwd.slice(1)}" ` +
        `instead of failing outright. Update the session's working directory to a real local path.`
    );
  }
}

// ---------------------------------------------------------------------------
// KiroRunner class
// ---------------------------------------------------------------------------

export class KiroRunner {
  private proc: ChildProcess;
  private conn!: any; // ACP ClientSideConnection
  private sessionId: string | null = null;
  private updateQueue: SessionUpdateChunk[] = [];
  private updateResolve: (() => void) | null = null;
  private turnDone = false;
  /** cwd/mcpServers the session was created with — reused by newSession(). */
  private sessionCwd!: string;
  private sessionMcpServers: McpServerEntry[] = [];
  /** Raw MCP server entries (HTTP or other) included verbatim in the payload. */
  private sessionRawMcpServers: unknown[] = [];

  /**
   * Credits consumed by the most recently completed prompt turn.
   * Set from the `_kiro.dev/metadata` notification that carries `meteringUsage`
   * (emitted just before the PromptResponse). Reset to 0 at the start of each
   * turn; read after the `prompt()` async generator completes.
   */
  private _lastTurnCredits = 0;
  /**
   * Error captured from a rejected `this.conn.prompt(...)` call.
   * Stored here so the async generator can drain any buffered updates before
   * re-throwing — callers see the error after all yielded updates are consumed.
   * Reset to null at the start of each turn.
   */
  private _promptError: Error | null = null;
  /**
   * MCP servers that failed to initialize for the current session (one entry
   * per `_kiro.dev/mcp/server_init_failure` notification). Mirrors the same
   * tracking in worker/worker.js's ACA path — this notification used to be
   * silently dropped here too (any `_kiro.dev/*` method other than
   * session/update or metadata fell through unhandled), so a local session
   * losing a tool mid-run had no visible signal at all. Reset on newSession().
   */
  private _mcpServerInitFailures: Array<{ name: string | null }> = [];

  private constructor(proc: ChildProcess) {
    this.proc = proc;
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  static async create(opts: KiroRunnerOptions): Promise<KiroRunner> {
    const acpSdk = await import("@agentclientprotocol/sdk");

    // Forward essential env vars to the subprocess
    const env: Record<string, string> = {};
    const forwardKeys = [
      "PATH", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE",
      "USER", "USERNAME", "SHELL", "TERM", "LANG", "NODE_ENV",
      "SSH_AUTH_SOCK", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
      "SystemRoot", "TEMP", "TMP",
    ];
    for (const key of forwardKeys) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    env.NO_COLOR = "1";
    env.FORCE_COLOR = "0";

    // Forward AWS auth
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AWS_")) env[key] = process.env[key]!;
    }

    // Kiro API key: per-user key takes precedence over global env var.
    // The decrypted key is only held in the env object for the duration of spawn().
    if (opts.kiroApiKey) {
      env.KIRO_API_KEY = opts.kiroApiKey;
    } else if (process.env.KIRO_API_KEY) {
      env.KIRO_API_KEY = process.env.KIRO_API_KEY;
    }

    const args = ["acp"];
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.model) args.push("--model", opts.model);

    assertNotContainerPathOnWindows(opts.cwd);
    const cwd = getShortPath(resolve(opts.cwd));

    // A missing cwd also makes Node's spawn() fail with ENOENT — identical to
    // a missing binary on Windows (both surface as `syscall: "spawn kiro-cli"`,
    // with no distinguishing field). Check cwd existence up front so we can
    // give an accurate error instead of always blaming kiro-cli itself. This
    // matters most when reusing a session persisted with a container-only cwd
    // (e.g. "/app" from a production ACA run) on a local machine.
    if (!existsSync(cwd)) {
      throw new Error(
        `Session working directory not found: "${cwd}" — this session may have been created ` +
          "in a different environment (e.g. a production container). Update the session's " +
          "working directory or create a new session for this machine."
      );
    }

    const proc = spawn("kiro-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });

    // Catch spawn errors (e.g. ENOENT when kiro-cli is not installed).
    // cwd existence was already verified above, so an ENOENT here means the
    // binary itself could not be found on PATH.
    const spawnReady = new Promise<void>((resolve, reject) => {
      proc.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(
            new Error(
              "kiro-cli not found on PATH — install it from https://cli.kiro.dev/install " +
                "or skip agent sessions. Task/board management works without it."
            )
          );
        } else {
          reject(
            new Error(`Failed to spawn kiro-cli: ${err.message}`)
          );
        }
      });
      // If the process has a PID, it spawned successfully
      if (proc.pid) {
        resolve();
      } else {
        proc.once("spawn", () => resolve());
      }
    });

    // Wait for the process to actually spawn before proceeding
    await spawnReady;

    if (process.platform !== "win32") proc.unref();

    // Drain stderr
    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) process.stderr.write(`  [kiro-cli stderr] ${msg}\n`);
    });

    const client = new KiroRunner(proc);
    const stdin = proc.stdin!;
    const stdout = proc.stdout!;

    // Writable side: serialize outgoing ACP messages to kiro-cli stdin
    const writable = new WritableStream({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          if (stdin.destroyed) return reject(new Error("stdin destroyed"));
          stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
        });
      },
      close() {
        stdin.end();
      },
    });

    // Readable side: parse incoming NDJSON from kiro-cli stdout
    let buffer = "";
    const decoder = new TextDecoder();
    let ctrl!: ReadableStreamDefaultController<any>;

    const readable = new ReadableStream({
      start(c) { ctrl = c; },
      cancel() { stdout.destroy(); },
    });

    function handleMessage(msg: any): void {
      // Intercept Kiro extension notifications
      if (
        "method" in msg &&
        typeof msg.method === "string" &&
        msg.method.startsWith("_kiro.dev/") &&
        !("id" in msg)
      ) {
        if (msg.method === "_kiro.dev/session/update") {
          const params = msg.params;
          if (params && "update" in params) {
            client.updateQueue.push(params.update as SessionUpdateChunk);
            client.updateResolve?.();
            client.updateResolve = null;
          }
        }
        // Capture credit/usage data from the end-of-turn metadata notification
        if (msg.method === "_kiro.dev/metadata") {
          const params = msg.params as {
            meteringUsage?: Array<{ value: number; unit: string; unitPlural: string }>;
          } | undefined;
          if (params?.meteringUsage?.length) {
            // Sum all credit entries (typically just one)
            let credits = 0;
            for (const entry of params.meteringUsage) {
              if (entry.unit === "credit") credits += entry.value;
            }
            client._lastTurnCredits = credits;
          }
        }
        // Record MCP server startup failures — see _mcpServerInitFailures doc.
        if (msg.method === "_kiro.dev/mcp/server_init_failure") {
          const params = (msg.params ?? {}) as Record<string, unknown>;
          const name = (params.name ?? params.server ?? params.serverName ?? null) as string | null;
          client._mcpServerInitFailures.push({ name });
        }
        return;
      }
      // Standard ACP message — forward to SDK
      ctrl.enqueue(msg);
    }

    stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.decode(new Uint8Array(chunk), { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleMessage(JSON.parse(trimmed));
        } catch {
          /* skip non-JSON lines */
        }
      }
    });

    stdout.on("end", () => {
      if (buffer.trim()) {
        try { handleMessage(JSON.parse(buffer.trim())); } catch { /* skip */ }
      }
      try { ctrl.close(); } catch { /* already closed */ }
    });

    stdout.on("error", (err) => {
      try { ctrl.error(err); } catch { /* ignore */ }
    });

    // Combine into ACP stream
    const dummyReadable = new ReadableStream({ start() {} });
    const ndJson = acpSdk.ndJsonStream(writable, dummyReadable);
    const stream = { readable, writable: ndJson.writable };

    // ACP Client implementation (auto-approve all permissions)
    const clientImpl = {
      async sessionUpdate(params: any): Promise<void> {
        client.updateQueue.push(params.update);
        client.updateResolve?.();
        client.updateResolve = null;
      },
      async requestPermission(params: any): Promise<any> {
        const options = params.options;
        const approve =
          options.find((o: any) => o.kind === "allow_once") ??
          options.find((o: any) => o.kind === "allow_always") ??
          options[0];
        return { outcome: { outcome: "selected", optionId: approve.optionId } };
      },
    };

    client.conn = new acpSdk.ClientSideConnection(() => clientImpl, stream);

    // Handshake
    await client.conn.initialize({
      protocolVersion: acpSdk.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    client.sessionCwd = cwd;
    client.sessionMcpServers = opts.mcpServers ?? [];
    client.sessionRawMcpServers = opts.rawMcpServers ?? [];

    const result = await client.conn.newSession({
      cwd,
      mcpServers: client.buildMcpServersPayload(),
    });
    client.sessionId = result.sessionId;

    return client;
  }

  /**
   * Always include the verdict MCP server so agents can report "no_action_needed".
   * `env` is required by kiro-cli's ACP schema (untagged enum match fails silently
   * without it — the whole session/new request gets rejected as a parse error).
   */
  private buildMcpServersPayload(): unknown[] {
    return [
      {
        name: "verdict",
        command: "node",
        args: [resolve(import.meta.dirname, "../../../worker/verdict-mcp-server.js")],
        env: [],
      },
      ...(this.sessionMcpServers as any[]),
      ...this.sessionRawMcpServers,
    ];
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a brand-new ACP session on the same already-running kiro-cli
   * subprocess, discarding all prior conversation history.
   *
   * Used between tasks in loop mode so each task gets a fresh context
   * instead of inheriting everything the previous task's turn accumulated —
   * see session-manager.ts's runLoopMode. Reuses the same cwd/mcpServers the
   * runner was created with, unless overridden.
   *
   * This does NOT respawn the kiro-cli process or redo `initialize` — only
   * `session/new` is re-issued, which is all that's needed since kiro-cli
   * scopes conversation state to sessionId.
   */
  async newSession(overrideCwd?: string): Promise<void> {
    if (overrideCwd) assertNotContainerPathOnWindows(overrideCwd);
    const cwd = overrideCwd ? getShortPath(resolve(overrideCwd)) : this.sessionCwd;
    this._mcpServerInitFailures = [];
    const result = await this.conn.newSession({
      cwd,
      mcpServers: this.buildMcpServersPayload(),
    });
    this.sessionId = result.sessionId;
    this.sessionCwd = cwd;
  }

  /** Send a prompt and yield streaming updates as they arrive. */
  async *prompt(text: string, image?: { data: string; mimeType: string }): AsyncGenerator<SessionUpdateChunk> {
    if (!this.sessionId) throw new Error("No active session");

    this.turnDone = false;
    this.updateQueue = [];
    this._lastTurnCredits = 0;
    this._promptError = null;

    const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text" as const, text },
    ];
    if (image) {
      contentBlocks.push({ type: "image" as const, data: image.data, mimeType: image.mimeType });
    }

    const promptDone = this.conn
      .prompt({
        sessionId: this.sessionId,
        prompt: contentBlocks,
      })
      .then(() => {
        this.turnDone = true;
        this.updateResolve?.();
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this._promptError = error;
        log.error("ACP prompt rejected", toErrorFields(error));
        this.turnDone = true;
        this.updateResolve?.();
      });

    while (true) {
      while (this.updateQueue.length > 0) {
        yield this.updateQueue.shift()!;
      }
      if (this.turnDone) break;
      await new Promise<void>((resolve) => {
        this.updateResolve = resolve;
      });
    }

    // Drain remaining
    while (this.updateQueue.length > 0) {
      yield this.updateQueue.shift()!;
    }

    await promptDone;

    // Re-throw captured error after all buffered updates have been yielded,
    // so callers (e.g. streamPrompt) see the failure via their existing
    // try/catch and can surface it to the session output stream.
    if (this._promptError) {
      throw this._promptError;
    }
  }

  /** Cancel the session and kill the kiro-cli subprocess. */
  async close(): Promise<void> {
    if (this.sessionId && this.proc.exitCode === null) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch {
        /* connection may already be dead */
      }
    }

    if (this.proc.exitCode === null) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/PID", String(this.proc.pid), "/T", "/F"],
            { stdio: "ignore" }
          );
          killer.on("exit", () => resolve());
          killer.on("error", () => resolve());
        });
      } else {
        this.proc.kill("SIGTERM");
      }
    }

    // Wait briefly for process to exit
    const deadline = Date.now() + 5000;
    while (this.proc.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Check if the subprocess is still alive. */
  get isAlive(): boolean {
    return this.proc.exitCode === null;
  }

  /** Get the subprocess PID. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /**
   * Credits consumed by the last completed prompt turn.
   * Read this after the `prompt()` async generator finishes to capture per-turn cost.
   * Returns 0 if no metering data was received (e.g. kiro-cli version without support).
   */
  get lastTurnCredits(): number {
    return this._lastTurnCredits;
  }

  /**
   * MCP servers that failed to start for the current session.
   * Empty array means no failures were reported. See _mcpServerInitFailures doc.
   */
  get mcpServerInitFailures(): Array<{ name: string | null }> {
    return this._mcpServerInitFailures;
  }
}
