/**
 * Tests for tryCaptureVerdictFromContent() in session-manager.ts.
 *
 * Bug: task #597's run on 2026-08-25 showed report_verdict genuinely being
 * called and returning `{"verdict":"no_action_needed", ...}`, yet the task
 * was reset to "todo" with "no verdict reported". Root cause: the old
 * capture logic only recorded a verdict when a `tool_call` update (which
 * sets `managed.verdictToolCallId` by matching `title.includes("report_verdict")`)
 * was followed by a `tool_call_update` whose `toolCallId` matched. In this
 * run, kiro-cli announced the report_verdict call through an update whose
 * `sessionUpdate` was not `"tool_call"` (it fell into the `default:` case,
 * rendered as the generic "ℹ️ report_verdict" line seen in the session log),
 * so `verdictToolCallId` was never set and the later completion could never
 * correlate — the verdict was silently dropped despite the tool call
 * succeeding.
 *
 * Fix: capture the verdict directly from any completed tool call's content
 * by shape (`{"verdict": "resolved" | "no_action_needed" | "changes_requested"}`),
 * independent of toolCallId correlation or which switch case observed it.
 */

import { describe, it, expect } from "vitest";
import { tryCaptureVerdictFromContent, type ManagedSession } from "../session-manager.js";

function makeManaged(): ManagedSession {
  return { turnVerdict: null } as ManagedSession;
}

describe("tryCaptureVerdictFromContent", () => {
  it("captures a valid verdict from content regardless of prior toolCallId tracking", () => {
    const managed = makeManaged();
    const content = [
      { type: "text", text: JSON.stringify({ verdict: "no_action_needed", reason: "Already implemented" }) },
    ];

    tryCaptureVerdictFromContent(managed, content);

    expect(managed.turnVerdict).toBe("no_action_needed");
  });

  it("captures 'resolved' and 'changes_requested' verdicts too", () => {
    const resolvedManaged = makeManaged();
    tryCaptureVerdictFromContent(resolvedManaged, [
      { type: "text", text: JSON.stringify({ verdict: "resolved", reason: "Implemented the fix" }) },
    ]);
    expect(resolvedManaged.turnVerdict).toBe("resolved");

    const changesManaged = makeManaged();
    tryCaptureVerdictFromContent(changesManaged, [
      { type: "text", text: JSON.stringify({ verdict: "changes_requested", reason: "Found issues" }) },
    ]);
    expect(changesManaged.turnVerdict).toBe("changes_requested");
  });

  it("ignores content with an invalid/unknown verdict value", () => {
    const managed = makeManaged();
    tryCaptureVerdictFromContent(managed, [
      { type: "text", text: JSON.stringify({ verdict: "totally_not_a_real_verdict" }) },
    ]);
    expect(managed.turnVerdict).toBeNull();
  });

  it("ignores non-JSON text blocks without throwing", () => {
    const managed = makeManaged();
    expect(() =>
      tryCaptureVerdictFromContent(managed, [{ type: "text", text: "Running command..." }]),
    ).not.toThrow();
    expect(managed.turnVerdict).toBeNull();
  });

  it("ignores content that is not an array (undefined, null, object)", () => {
    const managed = makeManaged();
    tryCaptureVerdictFromContent(managed, undefined);
    expect(managed.turnVerdict).toBeNull();

    tryCaptureVerdictFromContent(managed, null);
    expect(managed.turnVerdict).toBeNull();

    tryCaptureVerdictFromContent(managed, { not: "an array" });
    expect(managed.turnVerdict).toBeNull();
  });

  it("ignores blocks that are not type 'text' or lack text", () => {
    const managed = makeManaged();
    tryCaptureVerdictFromContent(managed, [
      { type: "image", text: JSON.stringify({ verdict: "resolved" }) },
      { type: "text" },
    ]);
    expect(managed.turnVerdict).toBeNull();
  });

  it("does not require a preceding tool_call announcement to be observed", () => {
    // Simulates the exact bug scenario: no tool_call/toolCallId tracking
    // happened at all before this content arrives (e.g. via the `default:`
    // switch case), yet the verdict must still be captured.
    const managed = makeManaged();
    tryCaptureVerdictFromContent(managed, [
      { type: "text", text: JSON.stringify({ verdict: "no_action_needed", reason: "Nothing to do" }) },
    ]);
    expect(managed.turnVerdict).toBe("no_action_needed");
  });
});
