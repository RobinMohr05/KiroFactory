/**
 * Tests for KiroRunner's container-path cwd guard.
 *
 * Bug: a Session's `cwd` persisted while the orchestrator ran inside its
 * Docker/ACA container (WORKDIR "/app", or the ACA worker's "/workspace")
 * survives in Neo4j across environments. If that session is later started
 * on a local Windows dev machine, `path.resolve("/app")` does NOT throw —
 * Node silently reinterprets a leading "/" as relative to the current
 * drive, producing "C:\app". If a directory happens to already exist at
 * that path (as one did here — a stray artifact from this exact bug), the
 * existing `existsSync` guard in `KiroRunner.create()` never fires, and
 * kiro-cli gets silently spawned into the wrong working tree instead of
 * failing loudly. `assertNotContainerPathOnWindows()` closes this gap by
 * rejecting any POSIX-absolute cwd up front, before it ever reaches
 * `path.resolve()`, whenever running on win32.
 *
 * Confirmed live 2026-08-21: six persisted sessions for this repo's
 * pipeline agents (developer-agent, code-reviewer-agent, qa-improvement-agent)
 * all had `cwd: "/app"` in Neo4j — a leftover from an earlier container run —
 * and a developer-agent loop run against one of them (task #597) reported a
 * bare, empty git repository at "C:\app" with no working tree.
 */

import { describe, it, expect, afterEach } from "vitest";
import { assertNotContainerPathOnWindows } from "../agent/kiro-runner.js";

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("assertNotContainerPathOnWindows", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("throws on a POSIX-absolute cwd like \"/app\" when running on win32", () => {
    setPlatform("win32");
    expect(() => assertNotContainerPathOnWindows("/app")).toThrow(/container-style path/);
  });

  it("throws on the ACA worker's \"/workspace\" cwd when running on win32", () => {
    setPlatform("win32");
    expect(() => assertNotContainerPathOnWindows("/workspace")).toThrow(/container-style path/);
  });

  it("does not throw on a real Windows path", () => {
    setPlatform("win32");
    expect(() =>
      assertNotContainerPathOnWindows("C:\\Projects\\1_Work\\19_Misc\\KiroFactory")
    ).not.toThrow();
  });

  it("does not throw on a POSIX-absolute cwd when NOT running on win32", () => {
    setPlatform("linux");
    expect(() => assertNotContainerPathOnWindows("/app")).not.toThrow();
  });
});
