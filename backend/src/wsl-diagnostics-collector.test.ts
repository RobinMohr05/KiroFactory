/**
 * Tests for wsl-diagnostics-collector.ts:
 *   - pure formatting/classification helpers (formatDockerEvent, isKiroFactoryContainer)
 *   - ring buffer capping and broadcast-on-push behavior
 *   - stream auto-restart on unexpected exit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("./logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  toErrorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
}));

vi.mock("./websocket-handler.js", () => ({
  broadcastToAll: vi.fn(),
}));

/** Minimal fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters and a kill() spy. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let spawnedProcesses: { file: string; args: string[]; proc: FakeChildProcess }[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { broadcastToAll } from "./websocket-handler.js";
import {
  formatDockerEvent,
  isKiroFactoryContainer,
  getDiagnosticBuffer,
  startWslDiagnosticsCollector,
  stopWslDiagnosticsCollector,
  _resetForTests,
  type DockerEventJson,
} from "./wsl-diagnostics-collector.js";

const spawnMock = vi.mocked(spawn);
const broadcastToAllMock = vi.mocked(broadcastToAll);

spawnMock.mockImplementation((file: unknown, args: unknown) => {
  const proc = new FakeChildProcess();
  spawnedProcesses.push({ file: file as string, args: args as string[], proc });
  return proc as unknown as ReturnType<typeof spawn>;
});

describe("formatDockerEvent", () => {
  it("formats a container kill event with its signal", () => {
    const ev: DockerEventJson = {
      Type: "container",
      Action: "kill",
      Actor: { Attributes: { name: "kirofactory-worker-73", signal: "15" } },
    };
    expect(formatDockerEvent(ev)).toBe("container kirofactory-worker-73 killed (signal: 15)");
  });

  it("formats a container die event with its exit code", () => {
    const ev: DockerEventJson = {
      Type: "container",
      Action: "die",
      Actor: { Attributes: { name: "kirofactory-worker-73", exitCode: "137" } },
    };
    expect(formatDockerEvent(ev)).toBe("container kirofactory-worker-73 died (exit code: 137)");
  });

  it("falls back to a generic Type/Action summary for other event kinds", () => {
    const ev: DockerEventJson = {
      Type: "network",
      Action: "connect",
      Actor: { Attributes: { name: "bridge" } },
    };
    expect(formatDockerEvent(ev)).toBe("network bridge connect");
  });

  it("handles a missing signal/exitCode gracefully", () => {
    const ev: DockerEventJson = { Type: "container", Action: "kill", Actor: { Attributes: {} } };
    expect(formatDockerEvent(ev)).toBe("container killed (signal: unknown)");
  });
});

describe("isKiroFactoryContainer", () => {
  it("matches worker containers", () => {
    expect(isKiroFactoryContainer("kirofactory-worker-73")).toBe(true);
  });

  it("matches mcp-proxy containers", () => {
    expect(isKiroFactoryContainer("kirofactory-mcp-proxy-73")).toBe(true);
  });

  it("does not match unrelated containers", () => {
    expect(isKiroFactoryContainer("hello-world")).toBe(false);
    expect(isKiroFactoryContainer(undefined)).toBe(false);
  });
});

describe("collector ring buffer + broadcast", () => {
  beforeEach(() => {
    spawnedProcesses = [];
    spawnMock.mockClear();
    broadcastToAllMock.mockClear();
    _resetForTests();
  });

  afterEach(() => {
    stopWslDiagnosticsCollector();
  });

  it("starts docker-events and dmesg streams via wsl.exe with the configured distro", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");

    const dockerEventsCall = spawnedProcesses.find((s) => s.args.includes("events"));
    const dmesgCall = spawnedProcesses.find((s) => s.args.includes("dmesg"));

    expect(dockerEventsCall).toBeTruthy();
    expect(dockerEventsCall!.file).toBe("wsl.exe");
    expect(dockerEventsCall!.args).toEqual(["-d", "kirofactory-docker-test", "--", "docker", "events", "--format", "{{json .}}"]);

    expect(dmesgCall).toBeTruthy();
    expect(dmesgCall!.args).toEqual(["-d", "kirofactory-docker-test", "--", "dmesg", "-w"]);
  });

  it("parses a docker-events NDJSON line, buffers it, and broadcasts it", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");
    const dockerEventsProc = spawnedProcesses.find((s) => s.args.includes("events"))!.proc;

    const eventJson = JSON.stringify({
      Type: "container",
      Action: "kill",
      Actor: { Attributes: { name: "kirofactory-worker-73", signal: "15" } },
    });
    dockerEventsProc.stdout.emit("data", Buffer.from(eventJson + "\n"));

    const buffer = getDiagnosticBuffer();
    expect(buffer.length).toBe(1);
    expect(buffer[0].source).toBe("docker-events");
    expect(buffer[0].text).toBe("container kirofactory-worker-73 killed (signal: 15)");
    expect(buffer[0].containerName).toBe("kirofactory-worker-73");

    expect(broadcastToAllMock).toHaveBeenCalledWith({
      type: "wsl-diagnostic-line",
      line: buffer[0],
    });
  });

  it("buffers a dmesg line verbatim", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");
    const dmesgProc = spawnedProcesses.find((s) => s.args.includes("dmesg"))!.proc;

    dmesgProc.stdout.emit("data", Buffer.from("[  123.456] OOM killed process 42\n"));

    const buffer = getDiagnosticBuffer();
    expect(buffer.length).toBe(1);
    expect(buffer[0].source).toBe("dmesg");
    expect(buffer[0].text).toBe("[  123.456] OOM killed process 42");
  });

  it("triggers a best-effort docker logs capture when a kirofactory container dies", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");
    const dockerEventsProc = spawnedProcesses.find((s) => s.args.includes("events"))!.proc;

    const dieEvent = JSON.stringify({
      Type: "container",
      Action: "die",
      Actor: { Attributes: { name: "kirofactory-worker-73", exitCode: "0" } },
    });
    dockerEventsProc.stdout.emit("data", Buffer.from(dieEvent + "\n"));

    // A second spawn (beyond the two long-lived streams) should have been
    // made for the `docker logs` capture.
    const logsCall = spawnedProcesses.find((s) => s.args.includes("logs"));
    expect(logsCall).toBeTruthy();
    expect(logsCall!.args).toEqual(["-d", "kirofactory-docker-test", "--", "docker", "logs", "--tail", "200", "kirofactory-worker-73"]);

    // Simulate the capture producing output and closing.
    logsCall!.proc.stdout.emit("data", Buffer.from("some captured log output\n"));
    logsCall!.proc.emit("close", 0);

    const buffer = getDiagnosticBuffer();
    const containerLogLine = buffer.find((l) => l.source === "container-log");
    expect(containerLogLine).toBeTruthy();
    expect(containerLogLine!.text).toContain("some captured log output");
    expect(containerLogLine!.containerName).toBe("kirofactory-worker-73");
  });

  it("does not trigger a log capture for non-kirofactory containers", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");
    const dockerEventsProc = spawnedProcesses.find((s) => s.args.includes("events"))!.proc;

    const dieEvent = JSON.stringify({
      Type: "container",
      Action: "die",
      Actor: { Attributes: { name: "hello-world", exitCode: "0" } },
    });
    dockerEventsProc.stdout.emit("data", Buffer.from(dieEvent + "\n"));

    const logsCall = spawnedProcesses.find((s) => s.args.includes("logs"));
    expect(logsCall).toBeUndefined();
  });

  it("caps the ring buffer at its configured maximum", () => {
    startWslDiagnosticsCollector("kirofactory-docker-test");
    const dmesgProc = spawnedProcesses.find((s) => s.args.includes("dmesg"))!.proc;

    // Push well beyond the 2000-line cap.
    for (let i = 0; i < 2100; i++) {
      dmesgProc.stdout.emit("data", Buffer.from(`line ${i}\n`));
    }

    const buffer = getDiagnosticBuffer();
    expect(buffer.length).toBe(2000);
    // Oldest lines should have been evicted — the buffer should start around line 100.
    expect(buffer[0].text).toBe("line 100");
    expect(buffer[buffer.length - 1].text).toBe("line 2099");
  });

  it("restarts a stream after it exits unexpectedly", async () => {
    vi.useFakeTimers();
    startWslDiagnosticsCollector("kirofactory-docker-test");
    expect(spawnedProcesses.filter((s) => s.args.includes("events")).length).toBe(1);

    const dockerEventsProc = spawnedProcesses.find((s) => s.args.includes("events"))!.proc;
    dockerEventsProc.emit("exit", 1, null);

    // Restart is scheduled with a backoff — advance past it.
    await vi.advanceTimersByTimeAsync(5_001);

    expect(spawnedProcesses.filter((s) => s.args.includes("events")).length).toBe(2);
    vi.useRealTimers();
  });

  it("does not restart a stream after an intentional stop", async () => {
    vi.useFakeTimers();
    startWslDiagnosticsCollector("kirofactory-docker-test");
    stopWslDiagnosticsCollector();

    const dockerEventsProc = spawnedProcesses.find((s) => s.args.includes("events"))!.proc;
    // Even if the process reports exit after being killed, no restart should follow.
    dockerEventsProc.emit("exit", 0, "SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawnedProcesses.filter((s) => s.args.includes("events")).length).toBe(1);
    vi.useRealTimers();
  });
});
