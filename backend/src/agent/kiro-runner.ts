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
  /** Agent name from .kiro/agents/ */
  agent: string;
  /** Working directory for the kiro-cli process */
  cwd: string;
  /** Optional model override */
  model?: string | null;
  /** Optional MCP servers to inject at session creation */
  mcpServers?: McpServerEntry[];
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

    const args = ["acp", "--agent", opts.agent];
    if (opts.model) args.push("--model", opts.model);

    const cwd = getShortPath(resolve(opts.cwd));

    const proc = spawn("kiro-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });

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

    const result = await client.conn.newSession({
      cwd,
      mcpServers: (opts.mcpServers ?? []) as any,
    });
    client.sessionId = result.sessionId;

    return client;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Send a prompt and yield streaming updates as they arrive. */
  async *prompt(text: string): AsyncGenerator<SessionUpdateChunk> {
    if (!this.sessionId) throw new Error("No active session");

    this.turnDone = false;
    this.updateQueue = [];

    const promptDone = this.conn
      .prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text" as const, text }],
      })
      .then(() => {
        this.turnDone = true;
        this.updateResolve?.();
      })
      .catch(() => {
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
}
