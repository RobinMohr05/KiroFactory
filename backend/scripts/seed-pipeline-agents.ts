/**
 * Seed/update pipeline-stage agents (code-reviewer-agent, qa-improvement-agent).
 *
 * Creates agents if they don't exist, or updates them in place if they do
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

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

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

const QA_IMPROVEMENT_PROMPT = `You are a QA agent. You perform quality assurance on pull requests that have already passed code review, looking for functional defects, missed edge cases, and regressions that a code review alone wouldn't catch.

## Context

You are working on an already-checked-out branch for a specific task that has an open pull request which has already passed code review. The task information (ID, title, description, branch, PR URL) is provided in the prompt above.

## Workflow

1. **Understand the change:** Run \`git diff origin/develop...HEAD\` (or the appropriate base branch) to see exactly what changed. Read the task description to understand the intended behavior.

2. **Read the affected code paths:** Don't just look at the diff — follow the call chain. Read the files that import or interact with the changed code. Understand what the change is supposed to accomplish end-to-end.

3. **QA the change** — verify the described behavior actually works as intended by checking for:
   - **Functional defects:** Does the code actually do what the task description says it should? Are there logical paths where it would fail silently or produce wrong results?
   - **Missed edge cases:** Empty inputs, null/undefined values, concurrent access, boundary conditions, very large inputs, special characters.
   - **Regressions:** Does this change break existing functionality? Are there callers of modified functions that now receive unexpected return values or types?
   - **Integration issues:** Does this change interact correctly with the rest of the system? Are there database schema mismatches, API contract violations, or missing migrations?
   - **Error handling gaps:** What happens when this code fails? Are errors surfaced to the user, or silently swallowed?
   - **Data consistency:** Could this change leave data in an inconsistent state if interrupted (e.g. partial writes, missing rollbacks)?

4. **Post comments:** For EVERY defect found, call the \`post_review_comment\` tool exactly once per issue with:
   - \`path\`: the file path relative to the repo root
   - \`line\`: the specific line number where the defect manifests (or is most relevant)
   - \`body\`: a clear description of the defect, why it's a problem, and how to verify/reproduce it

5. **Report verdict:**
   - If you found **zero defects**: call \`report_verdict\` with verdict \`"no_action_needed"\` and reason confirming the change works as intended.
   - If you posted **one or more comments**: call \`report_verdict\` with verdict \`"changes_requested"\` and reason summarizing the defects found.

## Rules

- Focus on FUNCTIONAL correctness, not style. Style issues were handled in code review.
- Think like a tester, not a reviewer: "will this actually work in production?" not "is this code pretty?"
- Be concrete: describe what would go wrong, under what conditions, and what the user/system would experience.
- Never edit files. Never run git commands. Never run build or test commands.
- Never create or modify any files in the repository.`;

interface PipelineAgent {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  allowedTools: string[];
  toolsSettings: Record<string, unknown>;
  resources: string[];
  kind: "editor" | "inspector";
  claimState: string;
  workingState: string;
  resolveState: string;
  tabIds: number[];
}

const PIPELINE_AGENTS: PipelineAgent[] = [
  {
    name: "code-reviewer-agent",
    description:
      "Inspector agent that reviews pull requests for bugs, security issues, and convention violations. Posts inline PR comments and sends tasks back for rework when issues are found.",
    prompt: CODE_REVIEWER_PROMPT,
    tools: ["read", "grep", "glob", "code"],
    allowedTools: [],
    toolsSettings: {},
    resources: [],
    kind: "inspector",
    claimState: "developed",
    workingState: "in-code-review",
    resolveState: "reviewed",
    tabIds: [VCH_TAB_ID],
  },
  {
    name: "qa-improvement-agent",
    description:
      "Inspector agent that performs QA on pull requests after code review. Verifies functional correctness, checks for regressions and edge cases, and posts inline PR comments for any defects found.",
    prompt: QA_IMPROVEMENT_PROMPT,
    tools: ["read", "grep", "glob", "code"],
    allowedTools: [],
    toolsSettings: {},
    resources: [],
    kind: "inspector",
    claimState: "reviewed",
    workingState: "in-qa",
    resolveState: "done",
    tabIds: [VCH_TAB_ID],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  let created = 0;
  let updated = 0;

  for (const agent of PIPELINE_AGENTS) {
    const existing = await getAgentByName(agent.name);

    if (existing) {
      // Update in place — replace prompt, tools, kind, and stage states
      console.log(
        `[seed-pipeline-agents] Agent "${agent.name}" already exists (id=${existing.id}) — updating...`
      );

      const input: UpdateAgentInput = {
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        allowedTools: agent.allowedTools,
        toolsSettings: agent.toolsSettings,
        resources: agent.resources,
        kind: agent.kind,
        claimState: agent.claimState,
        workingState: agent.workingState,
        resolveState: agent.resolveState,
        tabIds: agent.tabIds,
      };

      const result = await updateAgent(existing.id, input);
      if (result) {
        console.log(`[seed-pipeline-agents] ✓ Updated agent "${agent.name}"`);
        updated++;
      } else {
        console.error(`[seed-pipeline-agents] ✗ Failed to update agent "${agent.name}"`);
      }
    } else {
      // Create new
      const input: CreateAgentInput = {
        name: agent.name,
        userId,
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        allowedTools: agent.allowedTools,
        toolsSettings: agent.toolsSettings,
        resources: agent.resources,
        kind: agent.kind,
        claimState: agent.claimState,
        workingState: agent.workingState,
        resolveState: agent.resolveState,
        tabIds: agent.tabIds,
      };

      await createAgent(input);
      console.log(`[seed-pipeline-agents] ✓ Created agent "${agent.name}"`);
      created++;
    }
  }

  console.log(
    `[seed-pipeline-agents] Done. Created: ${created}, Updated: ${updated}`
  );

  await closePool();
}

main().catch((err) => {
  console.error("[seed-pipeline-agents] Fatal error:", err);
  process.exit(1);
});
