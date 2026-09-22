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

beforeEach(() => {
  resetActiveConnections();
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
