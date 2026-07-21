/**
 * KiroFactory MCP Proxy — Per-Session MCP Server Sidecar
 *
 * Based on the ta-mcp-proxy pattern from devcontainer-features.
 * Each Kiro session gets its own MCP proxy container for full isolation
 * (no credential sharing between sessions).
 *
 * Protocol:
 * 1. Worker connects via TCP to port 9090 (via ta-mcp-connect)
 * 2. First line from client: { "type": "connect", "server": "<name>" }
 * 3. Proxy spawns the requested MCP server (from /config/servers.json)
 * 4. Bidirectional NDJSON relay: client ↔ MCP server (stdin/stdout)
 *
 * Configuration:
 * - MCP_PROXY_PORT: TCP listen port (default 9090)
 * - MCP_SERVERS_CONFIG: Path to servers.json (default /config/servers.json)
 * - Health endpoint on MCP_PROXY_PORT + 1 (default 9091)
 */

import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || "9090", 10);
const HEALTH_PORT = PROXY_PORT + 1;
const SERVERS_CONFIG_PATH = process.env.MCP_SERVERS_CONFIG || "/config/servers.json";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: "mcp-proxy",
    msg,
    ...(data || {}),
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Server configuration loading
// ---------------------------------------------------------------------------

/** @type {Record<string, { command: string, args: string[], env?: Record<string, string> }>} */
let serversConfig = {};

function loadServersConfig() {
  // Priority 1: Base64-encoded config from environment variable (injected by orchestrator)
  const b64Config = process.env.MCP_SERVERS_JSON_B64;
  if (b64Config) {
    try {
      const decoded = Buffer.from(b64Config, "base64").toString("utf-8");
      serversConfig = JSON.parse(decoded);
      const names = Object.keys(serversConfig);
      log("info", `Loaded ${names.length} MCP server(s) from MCP_SERVERS_JSON_B64 env var`, { servers: names });

      // Also write to the config path for transparency/debugging
      try {
        mkdirSync(dirname(SERVERS_CONFIG_PATH), { recursive: true });
        writeFileSync(SERVERS_CONFIG_PATH, decoded, "utf-8");
      } catch { /* best effort */ }

      return;
    } catch (err) {
      log("error", "Failed to parse MCP_SERVERS_JSON_B64", { error: err.message });
      // Fall through to file-based config
    }
  }

  // Priority 2: File-based config
  if (!existsSync(SERVERS_CONFIG_PATH)) {
    log("warn", "servers.json not found, no MCP servers available", { path: SERVERS_CONFIG_PATH });
    serversConfig = {};
    return;
  }

  try {
    const raw = readFileSync(SERVERS_CONFIG_PATH, "utf-8");
    serversConfig = JSON.parse(raw);
    const names = Object.keys(serversConfig);
    log("info", `Loaded ${names.length} MCP server(s) from config`, { servers: names });
  } catch (err) {
    log("error", "Failed to parse servers.json", { error: err.message, path: SERVERS_CONFIG_PATH });
    serversConfig = {};
  }
}

// Initial load
loadServersConfig();

// Watch for config changes (orchestrator may update the file)
if (existsSync(SERVERS_CONFIG_PATH)) {
  watchFile(SERVERS_CONFIG_PATH, { interval: 5000 }, () => {
    log("info", "servers.json changed, reloading...");
    loadServersConfig();
  });
}

// ---------------------------------------------------------------------------
// MCP Server Process Management
// ---------------------------------------------------------------------------

/** Track active connections for health reporting */
let activeConnections = 0;

/**
 * Spawn an MCP server process for the given server name.
 * Returns the child process handle, or null if the server is not configured.
 */
function spawnMcpServer(serverName) {
  const config = serversConfig[serverName];
  if (!config) {
    log("error", `Unknown MCP server requested: "${serverName}"`, {
      available: Object.keys(serversConfig),
    });
    return null;
  }

  const { command, args = [], env: extraEnv = {} } = config;

  // Build environment: inherit process env + server-specific env
  const serverEnv = { ...process.env, ...extraEnv };

  log("info", `Spawning MCP server: ${serverName}`, { command, args });

  try {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: serverEnv,
      shell: false,
    });

    if (!child.pid) {
      log("error", `Failed to spawn MCP server "${serverName}"`, { command, args });
      return null;
    }

    log("info", `MCP server "${serverName}" spawned`, { pid: child.pid });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        log("debug", `[${serverName}] stderr: ${text}`);
      }
    });

    child.on("error", (err) => {
      log("error", `MCP server "${serverName}" error`, { error: err.message });
    });

    child.on("exit", (code, signal) => {
      log("info", `MCP server "${serverName}" exited`, { code, signal });
    });

    return child;
  } catch (err) {
    log("error", `Exception spawning MCP server "${serverName}"`, { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// TCP Server — Multiplexes MCP connections
// ---------------------------------------------------------------------------

const tcpServer = createTcpServer((socket) => {
  activeConnections++;
  let serverProc = null;
  let serverName = "unknown";
  let handshakeDone = false;
  let buffer = "";

  log("debug", "New TCP connection", { remote: socket.remoteAddress });

  socket.on("data", (chunk) => {
    if (!handshakeDone) {
      // Buffer until we get the full handshake line (first newline)
      buffer += chunk.toString();
      const nlIndex = buffer.indexOf("\n");
      if (nlIndex === -1) return; // Wait for more data

      const handshakeLine = buffer.slice(0, nlIndex).trim();
      const remainder = buffer.slice(nlIndex + 1);
      buffer = "";
      handshakeDone = true;

      // Parse handshake: { "type": "connect", "server": "<name>" }
      try {
        const msg = JSON.parse(handshakeLine);
        if (msg.type !== "connect" || !msg.server) {
          log("error", "Invalid handshake", { received: handshakeLine });
          socket.end(JSON.stringify({ error: "Invalid handshake — expected { type: 'connect', server: '<name>' }" }) + "\n");
          return;
        }
        serverName = msg.server;
      } catch {
        log("error", "Handshake parse error", { received: handshakeLine });
        socket.end(JSON.stringify({ error: "Handshake is not valid JSON" }) + "\n");
        return;
      }

      // Spawn the MCP server
      serverProc = spawnMcpServer(serverName);
      if (!serverProc) {
        socket.end(JSON.stringify({ error: `MCP server "${serverName}" not available` }) + "\n");
        return;
      }

      // Bridge: MCP server stdout → TCP socket (to worker)
      serverProc.stdout.on("data", (data) => {
        if (!socket.destroyed) {
          socket.write(data);
        }
      });

      // When MCP server exits, close the TCP socket
      serverProc.on("exit", () => {
        if (!socket.destroyed) {
          socket.end();
        }
      });

      // If there was data after the handshake newline, forward it to the MCP server
      if (remainder.length > 0) {
        serverProc.stdin.write(remainder);
      }
    } else {
      // Post-handshake: relay TCP data → MCP server stdin
      if (serverProc && serverProc.stdin.writable) {
        serverProc.stdin.write(chunk);
      }
    }
  });

  socket.on("end", () => {
    activeConnections--;
    log("debug", `TCP connection ended (server: ${serverName})`);
    if (serverProc) {
      try {
        serverProc.stdin.end();
        serverProc.kill("SIGTERM");
      } catch { /* best effort */ }
    }
  });

  socket.on("error", (err) => {
    activeConnections--;
    log("debug", `TCP socket error (server: ${serverName}): ${err.message}`);
    if (serverProc) {
      try {
        serverProc.kill("SIGTERM");
      } catch { /* best effort */ }
    }
  });
});

tcpServer.listen(PROXY_PORT, "0.0.0.0", () => {
  log("info", `MCP Proxy listening on port ${PROXY_PORT}`, {
    configPath: SERVERS_CONFIG_PATH,
    servers: Object.keys(serversConfig),
  });
});

// ---------------------------------------------------------------------------
// Health Check HTTP Server
// ---------------------------------------------------------------------------

const healthServer = createHttpServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      activeConnections,
      configuredServers: Object.keys(serversConfig),
      uptime: process.uptime(),
    }));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
  log("info", `Health check endpoint on port ${HEALTH_PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  log("info", `Received ${signal}, shutting down...`);
  tcpServer.close();
  healthServer.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
