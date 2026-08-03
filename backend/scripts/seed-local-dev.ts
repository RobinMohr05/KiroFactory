/**
 * Local development seed script.
 *
 * Creates a test user, a default tab, and sample tasks so you can log in
 * and see a populated Kanban board immediately after `npm run migrate`.
 *
 * Idempotent — safe to re-run without duplicating data.
 *
 * Usage:
 *   cd backend && npx tsx scripts/seed-local-dev.ts
 *   # or from repo root:
 *   npm run seed:local -w backend
 *
 * Credentials for the seeded user:
 *   Email:    local-dev@example.com
 *   Password: localdev123
 */

import dotenv from "dotenv";
dotenv.config();

import { getPool, sql, closePool, tryConnect } from "../src/db/connection.js";
import { createUser, getUserByEmail } from "../src/db/users.js";
import { createTab } from "../src/db/tabs.js";
import { createTask, updateTask } from "../src/db/tasks.js";

// ─── Seed data ───────────────────────────────────────────────────────────────

const TEST_USER = {
  email: "local-dev@example.com",
  password: "localdev123",
  kiroApiKey: "placeholder-not-a-real-key",
};

const TAB_NAME = "Local Dev";

interface SeedTask {
  title: string;
  priority: 1 | 2 | 3 | 4;
  type: "bug" | "feature" | "improvement";
  state: string;
  description: string;
  origin: "user" | "ai" | "user-assisted";
}

const SAMPLE_TASKS: SeedTask[] = [
  {
    title: "Fix login form not clearing error on retry",
    priority: 1,
    type: "bug",
    state: "todo",
    description:
      "When a user enters wrong credentials and then corrects them, the error message persists until the page is refreshed. The error state should clear on new submission.",
    origin: "user",
  },
  {
    title: "Add dark mode toggle to the settings page",
    priority: 2,
    type: "feature",
    state: "todo",
    description:
      "Users should be able to switch between light and dark themes via a toggle in settings. Persist the preference in localStorage.",
    origin: "user-assisted",
  },
  {
    title: "Optimize task list query for large boards",
    priority: 3,
    type: "improvement",
    state: "todo",
    description:
      "The current query fetches all tasks without pagination. Add limit/offset support to the GET /api/tasks endpoint for boards with 100+ tasks.",
    origin: "ai",
  },
  {
    title: "Implement drag-and-drop reordering within columns",
    priority: 2,
    type: "feature",
    state: "in-progress",
    description:
      "Tasks within a single Kanban column should be reorderable by drag-and-drop. Currently only cross-column moves are supported.",
    origin: "user",
  },
  {
    title: "Refactor WebSocket message types to use discriminated unions",
    priority: 4,
    type: "improvement",
    state: "in-progress",
    description:
      "The current WS message handling uses string comparisons. Refactor to TypeScript discriminated unions for better type safety and autocompletion.",
    origin: "ai",
  },
  {
    title: "Add keyboard shortcuts for common actions",
    priority: 3,
    type: "feature",
    state: "developed",
    description:
      "Implement keyboard shortcuts: N for new task, E for edit, Delete for remove, Escape to close modals. Show a help overlay with ? key.",
    origin: "user-assisted",
  },
  {
    title: "Fix priority badge colors in high-contrast mode",
    priority: 2,
    type: "bug",
    state: "developed",
    description:
      "Priority badges (P1-P4) lack sufficient contrast in high-contrast mode. Update the color palette to meet WCAG AA requirements.",
    origin: "user",
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[seed-local-dev] Starting local development seed...\n");

  // Connect to database
  const pool = await tryConnect();
  if (!pool) {
    console.error(
      "[seed-local-dev] ✗ Could not connect to database. " +
        "Make sure the database exists and .env is configured correctly.\n" +
        "  See: backend/.env.local.example"
    );
    process.exit(1);
  }

  // 1. Create or find the test user
  let user = await getUserByEmail(TEST_USER.email);
  if (user) {
    console.log(
      `[seed-local-dev] ⏭ User "${TEST_USER.email}" already exists (id=${user.id}) — skipping creation.`
    );
  } else {
    user = await createUser(TEST_USER);
    console.log(
      `[seed-local-dev] ✓ Created user "${TEST_USER.email}" (id=${user.id})`
    );
  }

  // 2. Create a default tab if one doesn't already exist for this user
  const existingTabs = await pool
    .request()
    .input("userId", sql.Int, user.id)
    .input("name", sql.NVarChar(100), TAB_NAME)
    .query(`SELECT id FROM tabs WHERE user_id = @userId AND name = @name`);

  let tabId: number;
  if (existingTabs.recordset.length > 0) {
    tabId = existingTabs.recordset[0].id as number;
    console.log(
      `[seed-local-dev] ⏭ Tab "${TAB_NAME}" already exists (id=${tabId}) — skipping creation.`
    );
  } else {
    const tab = await createTab({ name: TAB_NAME, userId: user.id });
    tabId = tab.id;
    console.log(`[seed-local-dev] ✓ Created tab "${TAB_NAME}" (id=${tabId})`);
  }

  // 3. Create sample tasks (skip if any tasks already exist for this tab)
  const existingTaskCount = await pool
    .request()
    .input("tabId", sql.Int, tabId)
    .query(`SELECT COUNT(*) AS cnt FROM task_tabs WHERE tab_id = @tabId`);

  if (existingTaskCount.recordset[0].cnt > 0) {
    console.log(
      `[seed-local-dev] ⏭ Tab already has tasks — skipping sample task creation.`
    );
  } else {
    console.log(`[seed-local-dev] Creating ${SAMPLE_TASKS.length} sample tasks...`);

    for (const taskDef of SAMPLE_TASKS) {
      const task = await createTask({
        title: taskDef.title,
        priority: taskDef.priority,
        type: taskDef.type,
        description: taskDef.description,
        origin: taskDef.origin,
        tabIds: [tabId],
      });

      // Move tasks to their target state (createTask always starts at "todo")
      if (taskDef.state !== "todo") {
        await updateTask(task.id, { state: taskDef.state });
      }

      console.log(
        `[seed-local-dev]   ✓ [${taskDef.state.padEnd(11)}] P${taskDef.priority} ${taskDef.type.padEnd(11)} "${taskDef.title}"`
      );
    }
  }

  // Done
  console.log("\n[seed-local-dev] ✓ Seed complete!");
  console.log("[seed-local-dev]");
  console.log("[seed-local-dev] Login credentials:");
  console.log(`[seed-local-dev]   Email:    ${TEST_USER.email}`);
  console.log(`[seed-local-dev]   Password: ${TEST_USER.password}`);
  console.log("[seed-local-dev]");

  await closePool();
}

main().catch((err) => {
  console.error("[seed-local-dev] Fatal error:", err);
  process.exit(1);
});
