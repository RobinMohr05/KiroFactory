/**
 * Seed/update pipeline-stage agents (code-reviewer-agent).
 *
 * Creates the agent if it doesn't exist, or updates it in place if it does
 * (e.g. from a prior ValueModeller-era import).
 *
 * Usage: cd backend && npx tsx scripts/seed-pipeline-agents.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { getPool, sql, closePool } from "../src/db/connection.js";
import { createAgent, updateAgent, getAgentByName } from "../src/db/agents.js";
import type { CreateAgentInput, UpdateAgentInput } from "../src/types.js";

const TARGET_EMAIL = "robin.mohr@tecalliance.net";

// Tab ID for VCH (Vibecode Heaven / KiroFactory repository)
const VCH_TAB_ID = 2;

const CODE_REVIEWER_PROMPT = `You are a code reviewer agent. You review pull requests by reading the diff, identifying concrete issues, and posting inline review comments on the PR.

## Context

You are working on an already-checked-out branch for a specific task that has an open pull request. The task information (ID, title, description, branch, PR URL) is provided in the prompt above.

## Workflow

1. **Identify what changed:** Run \`git diff origin/develop...HEAD\` (or the appropriate base branch) to see exactly what files and lines changed for this task. If that fails, use \`git log --oneline -1\` to confirm you're on the right branch, then try \`git diff HEAD~1\` as a fallback.

2. **Review the diff** for concrete, actionable issues:
   - Bugs or logic errors
   - Missed edge cases (null checks, empty arrays, boundary conditions)
   - Security issues (injection, secrets in code, missing auth checks)
   - Convention/style violations against the project's existing patterns
   - Missing error handling
   - Performance concerns (unnecessary re-renders, O(n²) where O(n) is easy)
   - Incomplete implementations (TODOs left behind, partial features)

3. **Post comments:** For EVERY issue found, call the \`post_review_comment\` tool exactly once per issue with:
   - \`path\`: the file path relative to the repo root
   - \`line\`: the specific line number in the new (right) side of the diff
   - \`body\`: a clear, specific comment explaining the issue and suggesting a fix

4. **Report verdict:**
   - If you found **zero issues**: call \`report_verdict\` with verdict \`"no_action_needed"\` and reason explaining the code looks good.
   - If you posted **one or more comments**: call \`report_verdict\` with verdict \`"changes_requested"\` and reason summarizing what was found.

## Rules

- Do NOT nitpick trivial style unless it clearly violates existing project conventions.
- Do NOT suggest rewrites of code that works correctly and is readable.
- Be specific: reference exact variable names, function calls, or logic paths.
- Each comment should be self-contained — the developer should understand the issue without needing to read other comments.
- Never edit files. Never run git commit/push. Never run build or test commands.
- Never create or modify any files in the repository.
- Focus on the CHANGED lines — don't review unchanged code unless a change introduces a bug in how it interacts with existing code.`;

const CODE_REVIEWER_AGENT = {
  name: "code-reviewer-agent",
  description:
    "Inspector agent that reviews pull requests for bugs, security issues, and convention violations. Posts inline PR comments and sends tasks back for rework when issues are found.",
  prompt: CODE_REVIEWER_PROMPT,
  tools: ["read", "grep", "glob", "code"],
  allowedTools: [] as string[],
  toolsSettings: {},
  resources: [] as string[],
  kind: "inspector" as const,
  claimState: "developed",
  workingState: "in-code-review",
  resolveState: "reviewed",
  tabIds: [VCH_TAB_ID],
};

async function main(): Promise<void> {
  console.log("[seed-pipeline-agents] Starting pipeline agent seed...");

  const pool = await getPool();

  // Look up user by email
  const userResult = await pool
    .request()
    .input("email", sql.NVarChar(255), TARGET_EMAIL)
    .query("SELECT id FROM users WHERE email = @email");

  if (userResult.recordset.length === 0) {
    console.error(
      `[seed-pipeline-agents] ✗ User "${TARGET_EMAIL}" not found in database. Cannot assign agents.`
    );
    await closePool();
    process.exit(1);
  }

  const userId = userResult.recordset[0].id as number;
  console.log(`[seed-pipeline-agents] Found user "${TARGET_EMAIL}" with id=${userId}`);

  // Check if the agent already exists
  const existing = await getAgentByName(CODE_REVIEWER_AGENT.name);

  if (existing) {
    // Update in place — replace prompt, tools, kind, and stage states
    console.log(
      `[seed-pipeline-agents] Agent "${CODE_REVIEWER_AGENT.name}" already exists (id=${existing.id}) — updating...`
    );

    const input: UpdateAgentInput = {
      description: CODE_REVIEWER_AGENT.description,
      prompt: CODE_REVIEWER_AGENT.prompt,
      tools: CODE_REVIEWER_AGENT.tools,
      allowedTools: CODE_REVIEWER_AGENT.allowedTools,
      toolsSettings: CODE_REVIEWER_AGENT.toolsSettings,
      resources: CODE_REVIEWER_AGENT.resources,
      kind: CODE_REVIEWER_AGENT.kind,
      claimState: CODE_REVIEWER_AGENT.claimState,
      workingState: CODE_REVIEWER_AGENT.workingState,
      resolveState: CODE_REVIEWER_AGENT.resolveState,
      tabIds: CODE_REVIEWER_AGENT.tabIds,
    };

    const updated = await updateAgent(existing.id, input);
    if (updated) {
      console.log(`[seed-pipeline-agents] ✓ Updated agent "${CODE_REVIEWER_AGENT.name}"`);
    } else {
      console.error(`[seed-pipeline-agents] ✗ Failed to update agent "${CODE_REVIEWER_AGENT.name}"`);
    }
  } else {
    // Create new
    const input: CreateAgentInput = {
      name: CODE_REVIEWER_AGENT.name,
      userId,
      description: CODE_REVIEWER_AGENT.description,
      prompt: CODE_REVIEWER_AGENT.prompt,
      tools: CODE_REVIEWER_AGENT.tools,
      allowedTools: CODE_REVIEWER_AGENT.allowedTools,
      toolsSettings: CODE_REVIEWER_AGENT.toolsSettings,
      resources: CODE_REVIEWER_AGENT.resources,
      kind: CODE_REVIEWER_AGENT.kind,
      claimState: CODE_REVIEWER_AGENT.claimState,
      workingState: CODE_REVIEWER_AGENT.workingState,
      resolveState: CODE_REVIEWER_AGENT.resolveState,
      tabIds: CODE_REVIEWER_AGENT.tabIds,
    };

    await createAgent(input);
    console.log(`[seed-pipeline-agents] ✓ Created agent "${CODE_REVIEWER_AGENT.name}"`);
  }

  console.log("[seed-pipeline-agents] Done.");
  await closePool();
}

main().catch((err) => {
  console.error("[seed-pipeline-agents] Fatal error:", err);
  process.exit(1);
});
