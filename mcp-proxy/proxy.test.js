/**
 * Tests for the MCP proxy per-connection teardown accounting.
 *
 * Regression coverage for: "activeConnections counter is unreliable
 * (double-decrement, no close handler)". A connection must adjust
 * activeConnections by exactly +1 on connect and -1 on teardown, no matter
 * which combination of `end` / `error` / `close` events the socket emits.
 *
 * Run with: node --test
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  handleConnection,
  getActiveConnections,
  resetActiveConnections,
  setSpawnOverrideForTest,
} from "./proxy.js";

/** Minimal socket stub: an EventEmitter with the fields proxy.js touches. */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.remoteAddress = "127.0.0.1";
  socket.destroyed = false;
  socket.write = () => {};
  socket.end = () => {};
  return socket;
}

/**
 * Minimal MCP-server child stub: an EventEmitter with `stdin`/`stdout`
 * sub-streams (also EventEmitters) exposing the fields proxy.js touches.
 * `stdinWritable` controls the `stdin.writable` flag; `stdin.write` records
 * calls so tests can assert whether the proxy attempted a write.
 */
function fakeChild({ stdinWritable = true } = {}) {
  const stdin = new EventEmitter();
  stdin.writable = stdinWritable;
  stdin.writes = [];
  stdin.write = (data) => { stdin.writes.push(data); return true; };
  stdin.end = () => {};

  const stdout = new EventEmitter();

  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = stdin;
  child.stdout = stdout;
  child.kill = () => {};
  return child;
}

beforeEach(() => {
  resetActiveConnections();
  setSpawnOverrideForTest(null);
});

test("a single connection that ends decrements exactly once", () => {
  const socket = fakeSocket();
  handleConnection(socket);
  assert.equal(getActiveConnections(), 1);

  socket.emit("end");
  socket.emit("close");
  assert.equal(getActiveConnections(), 0);
});

test("error followed by close does not double-decrement (no drift negative)", () => {
  const socket = fakeSocket();
  handleConnection(socket);
  assert.equal(getActiveConnections(), 1);

  // A socket can emit `error` and then `end`/`close` for the same connection.
  socket.emit("error", new Error("ECONNRESET"));
  socket.emit("end");
  socket.emit("close");

  assert.equal(getActiveConnections(), 0);
});

test("a socket destroyed/reset with only close (no end, no error) still decrements", () => {
  const socket = fakeSocket();
  handleConnection(socket);
  assert.equal(getActiveConnections(), 1);

  // Destroyed/reset socket: only `close` fires, never `end`.
  socket.emit("close");

  assert.equal(getActiveConnections(), 0);
});

test("many mixed connections settle back to zero without drift", () => {
  const sockets = Array.from({ length: 5 }, () => {
    const s = fakeSocket();
    handleConnection(s);
    return s;
  });
  assert.equal(getActiveConnections(), 5);

  // Mixed teardown patterns across the connections.
  sockets[0].emit("close");
  sockets[1].emit("end");
  sockets[1].emit("close");
  sockets[2].emit("error", new Error("boom"));
  sockets[2].emit("close");
  sockets[3].emit("error", new Error("boom"));
  sockets[3].emit("end");
  sockets[3].emit("close");
  sockets[4].emit("end");
  sockets[4].emit("close");

  assert.equal(getActiveConnections(), 0);
});

// ---------------------------------------------------------------------------
// Regression coverage for: "unguarded stdin write of post-handshake remainder
// can crash on EPIPE". If the spawned MCP server dies immediately after spawn
// (stdin no longer writable), the proxy must NOT write the post-handshake
// remainder to a non-writable stdin, and any stdin 'error' must be handled
// rather than becoming an unhandled stream error that crashes the proxy.
// ---------------------------------------------------------------------------

test("post-handshake remainder is NOT written when server stdin is not writable", () => {
  const child = fakeChild({ stdinWritable: false });
  setSpawnOverrideForTest(() => child);

  const socket = fakeSocket();
  handleConnection(socket);

  // Handshake line + remainder bytes in a single chunk.
  socket.emit(
    "data",
    Buffer.from('{"type":"connect","server":"demo"}\nHELLO_REMAINDER'),
  );

  assert.deepEqual(child.stdin.writes, []);
});

test("post-handshake remainder IS written when server stdin is writable", () => {
  const child = fakeChild({ stdinWritable: true });
  setSpawnOverrideForTest(() => child);

  const socket = fakeSocket();
  handleConnection(socket);

  socket.emit(
    "data",
    Buffer.from('{"type":"connect","server":"demo"}\nHELLO_REMAINDER'),
  );

  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0].toString(), "HELLO_REMAINDER");
});

test("an 'error' emitted on server stdin does not throw (has an error handler)", () => {
  const child = fakeChild({ stdinWritable: true });
  setSpawnOverrideForTest(() => child);

  const socket = fakeSocket();
  handleConnection(socket);

  // Complete the handshake so serverProc/stdin are wired up.
  socket.emit("data", Buffer.from('{"type":"connect","server":"demo"}\n'));

  // Without an 'error' listener, EventEmitter throws on an emitted 'error'.
  assert.doesNotThrow(() => {
    child.stdin.emit("error", new Error("EPIPE"));
  });
});
