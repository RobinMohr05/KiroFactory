/**
 * Tests for the AI Task Planner resume-transcript helpers in
 * routes/task-planner.ts:
 *   - capResumeTranscript: bounds a replayed transcript to the last 40 messages
 *     AND ~12000 characters (whichever is smaller), keeping the most recent.
 *   - buildResumeBlock: formats a capped transcript into a "## Resumed
 *     Conversation" system-prompt block as an ordered User/Assistant dialogue.
 */

import { describe, it, expect } from "vitest";
import { capResumeTranscript, buildResumeBlock } from "./task-planner.js";
import type { PlannerMessageRecord } from "../db/planner-conversations.js";

function msg(role: "user" | "assistant", text: string, position: number): PlannerMessageRecord {
  return { role, text, position, createdAt: "2026-09-21T10:00:00.000Z" };
}

describe("capResumeTranscript", () => {
  it("returns all messages when under both caps", () => {
    const messages = [msg("user", "hi", 0), msg("assistant", "hello", 1)];
    const result = capResumeTranscript(messages);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("hi");
  });

  it("keeps only the last 40 messages, most recent kept", () => {
    const messages: PlannerMessageRecord[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push(msg(i % 2 === 0 ? "user" : "assistant", `m${i}`, i));
    }
    const result = capResumeTranscript(messages);
    expect(result).toHaveLength(40);
    // Most recent kept — last message is m59
    expect(result[result.length - 1].text).toBe("m59");
    // First kept is m20 (60 - 40)
    expect(result[0].text).toBe("m20");
  });

  it("caps by ~12000 characters, keeping the most recent messages", () => {
    // 5 messages of 5000 chars each = 25000 chars total; only the most recent
    // that fit under ~12000 should be kept.
    const messages: PlannerMessageRecord[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(msg("user", "x".repeat(5000), i));
    }
    const result = capResumeTranscript(messages);
    const totalChars = result.reduce((sum, m) => sum + m.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(12000);
    // Must keep the MOST recent messages (highest positions)
    expect(result[result.length - 1].position).toBe(4);
    // Fewer than the full 5 messages survive
    expect(result.length).toBeLessThan(5);
    expect(result.length).toBeGreaterThan(0);
  });

  it("keeps at least the single most recent message even if it exceeds the char cap", () => {
    const messages = [msg("user", "y".repeat(20000), 0)];
    const result = capResumeTranscript(messages);
    expect(result).toHaveLength(1);
    expect(result[0].position).toBe(0);
  });
});

describe("buildResumeBlock", () => {
  it("formats an ordered User/Assistant dialogue under a Resumed Conversation header", () => {
    const messages = [
      msg("user", "Add login", 0),
      msg("assistant", "What provider?", 1),
      msg("user", "OAuth", 2),
    ];
    const block = buildResumeBlock(messages);
    expect(block).toContain("## Resumed Conversation");
    expect(block).toContain("User: Add login");
    expect(block).toContain("Assistant: What provider?");
    expect(block).toContain("User: OAuth");
    // Order preserved: user "Add login" appears before assistant reply
    expect(block.indexOf("Add login")).toBeLessThan(block.indexOf("What provider?"));
  });
});
