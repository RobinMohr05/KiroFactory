#!/usr/bin/env node
/**
 * Reusable task-creation script — the standard way to create one or more
 * :Task nodes directly via the DB layer (backend/src/db/tasks.ts createTask),
 * following the defaults documented in .kiro/steering/task-origin-convention.md.
 *
 * Why this exists: every task-creation request in this workspace used to get
 * its own hand-written, throwaway script under .temp/ (e.g. an earlier
 * .temp/create-auto-merge-tasks.ts) — a hardcoded array of task objects,
 * written fresh per request, run once, then deleted. That worked but meant
 * re-deriving the same "createTask() in a loop, resolve dependsOn indexes to
 * real ids after creation" logic every time. This script generalizes that
 * pattern into one parameterized, committed tool so it never needs
 * rewriting again — see .kiro/steering/task-origin-convention.md for how
 * this fits into the broader task-creation workflow.
 *
 * This script NEVER hardcodes credentials — like every other script in this
 * folder (seed-agents.ts, seed-local-dev.ts, verify-neo4j.ts), it reads
 * NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD from backend/.env via dotenv at
 * runtime. Nothing here should ever contain a literal secret.
 *
 * Usage:
 *   cd backend && npx tsx scripts/create-task.ts --file <path-to-json>
 *   cd backend && npx tsx scripts/create-task.ts --json '[{"title": "...", ...}]'
 *   npm run create:task -w backend -- --file <path-to-json>
 *
 * Input: a JSON array of task specs:
 *   [
 *     {
 *       "title": "string, required",
 *       "type": "bug" | "feature" | "improvement",     // required
 *       "priority": 1 | 2 | 3 | 4,                      // required, 1 = Critical
 *       "tabIds": [2],                                  // required — no silent
 *                                                        // default. See
 *                                                        // task-origin-convention.md
 *                                                        // for the confirmed
 *                                                        // VCH=2 mapping, or
 *                                                        // query `tabs` for
 *                                                        // any other repo.
 *       "description": "optional, default \"\"",
 *       "files": ["optional array of relevant file paths"],
 *       "origin": "user" | "ai" | "user-assisted",      // optional, default
 *                                                        // "user-assisted"
 *                                                        // per
 *                                                        // task-origin-convention.md
 *       "groupId": "optional string or null — shared branch/PR grouping,
 *                    NOT the same thing as a dependency, see below",
 *       "dependsOnBatchIndex": [0],   // optional — 0-based indexes into THIS
 *                                     // array, referring only to EARLIER
 *                                     // entries (an entry can't depend on
 *                                     // itself or a later one). Resolved to
 *                                     // real task IDs after each task in the
 *                                     // batch is created. Use this for
 *                                     // dependencies within one invocation.
 *       "dependsOnTaskId": [585]      // optional — real, already-existing
 *                                     // task IDs already in the database
 *                                     // (from a past session/invocation).
 *                                     // Validated to exist before anything
 *                                     // is created.
 *     },
 *     ...
 *   ]
 *
 * Tasks are created sequentially in array order, each as its own DB write
 * (createTask() opens its own transaction per call — there is no single
 * multi-task transaction spanning the whole batch). All specs are validated
 * up front, before any DB connection is made, to catch shape mistakes
 * without side effects. tabIds and dependsOnTaskId existence are also
 * checked against the real database before creating anything. If a later
 * task in a batch fails after earlier ones already committed, the script
 * reports exactly which ids were created before the failure — it does not
 * attempt to roll those back (createTask() calls are independent commits).
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
dotenv.config();

import { tryConnect, closePool, readQuery } from "../src/db/connection.js";
import { createTask } from "../src/db/tasks.js";
import type { CreateTaskInput } from "../src/types.js";
import type { ManagedTransaction } from "neo4j-driver";

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const HELP_TEXT = `
Create one or more tasks on the KiroFactory task board.

Usage:
  npx tsx scripts/create-task.ts --file <path-to-json>
  npx tsx scripts/create-task.ts --json '<inline json array>'

See this file's header comment for the full input JSON shape.
`;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  return values;
}

// ─── Input types & validation ───────────────────────────────────────────────

interface TaskSpec {
  title: string;
  type: "bug" | "feature" | "improvement";
  priority: 1 | 2 | 3 | 4;
  tabIds: number[];
  description?: string;
  files?: string[];
  origin?: "user" | "ai" | "user-assisted";
  groupId?: string | null;
  dependsOnBatchIndex?: number[];
  dependsOnTaskId?: number[];
}

const VALID_TYPES = new Set(["bug", "feature", "improvement"]);
const VALID_PRIORITIES = new Set([1, 2, 3, 4]);
const VALID_ORIGINS = new Set(["user", "ai", "user-assisted"]);

/**
 * Validates the raw parsed JSON shape before any DB interaction. Throws with
 * a descriptive message on the first problem found.
 */
function validateSpecs(raw: unknown): TaskSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Input must be a non-empty JSON array of task specs.");
  }

  raw.forEach((entry, i) => {
    const label = `Task spec at index ${i}`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${label}: must be an object.`);
    }
    const spec = entry as Record<string, unknown>;

    if (typeof spec.title !== "string" || spec.title.trim() === "") {
      throw new Error(`${label}: "title" is required and must be a non-empty string.`);
    }

    const type = spec.type;
    if (typeof type !== "string" || !VALID_TYPES.has(type)) {
      throw new Error(`${label}: "type" must be one of "bug" | "feature" | "improvement".`);
    }

    const priority = spec.priority;
    if (typeof priority !== "number" || !VALID_PRIORITIES.has(priority)) {
      throw new Error(`${label}: "priority" must be one of 1, 2, 3, 4 (1 = Critical).`);
    }

    const tabIds = spec.tabIds;
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      throw new Error(
        `${label}: "tabIds" is required and must be a non-empty array of numbers. ` +
          `See .kiro/steering/task-origin-convention.md for the confirmed VCH=2 mapping, ` +
          `or query the "tabs" data for any other repo — there is no silent default here.`
      );
    }
    if (!tabIds.every((id) => typeof id === "number")) {
      throw new Error(`${label}: "tabIds" must contain only numbers.`);
    }

    if (spec.description !== undefined && typeof spec.description !== "string") {
      throw new Error(`${label}: "description" must be a string if provided.`);
    }

    if (spec.files !== undefined) {
      const files = spec.files;
      if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) {
        throw new Error(`${label}: "files" must be an array of strings if provided.`);
      }
    }

    if (spec.origin !== undefined && !VALID_ORIGINS.has(spec.origin as string)) {
      throw new Error(`${label}: "origin" must be one of "user" | "ai" | "user-assisted" if provided.`);
    }

    if (spec.groupId !== undefined && spec.groupId !== null && typeof spec.groupId !== "string") {
      throw new Error(`${label}: "groupId" must be a string or null if provided.`);
    }

    if (spec.dependsOnBatchIndex !== undefined) {
      const deps = spec.dependsOnBatchIndex;
      if (!Array.isArray(deps) || !deps.every((d) => typeof d === "number" && Number.isInteger(d))) {
        throw new Error(`${label}: "dependsOnBatchIndex" must be an array of integer indexes if provided.`);
      }
      for (const depIndex of deps) {
        if (depIndex < 0 || depIndex >= i) {
          throw new Error(
            `${label}: "dependsOnBatchIndex" value ${depIndex} is invalid — it must refer to an ` +
              `EARLIER entry in this same array (index < ${i}). A task can't depend on itself or ` +
              `on an entry that hasn't been created yet in this batch. To depend on an ` +
              `already-existing task, use "dependsOnTaskId" instead.`
          );
        }
      }
    }

    if (spec.dependsOnTaskId !== undefined) {
      const deps = spec.dependsOnTaskId;
      if (!Array.isArray(deps) || !deps.every((d) => typeof d === "number" && Number.isInteger(d))) {
        throw new Error(`${label}: "dependsOnTaskId" must be an array of integer task ids if provided.`);
      }
    }
  });

  return raw as TaskSpec[];
}

/** Confirms every referenced tabId actually exists, before creating anything. */
async function validateTabsExist(specs: TaskSpec[]): Promise<void> {
  const allTabIds = new Set<number>();
  for (const spec of specs) for (const id of spec.tabIds) allTabIds.add(id);

  const existingIds = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`UNWIND $tabIds AS tabId MATCH (tab:Tab {id: tabId}) RETURN tab.id AS id`, {
      tabIds: Array.from(allTabIds),
    });
    return new Set(result.records.map((r) => r.get("id") as number));
  });

  const missing = Array.from(allTabIds).filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new Error(`tabIds not found in the database: ${missing.join(", ")}. Query "tabs" to find the correct id.`);
  }
}

/** Confirms every referenced dependsOnTaskId actually exists, before creating anything. */
async function validateDependencyTasksExist(specs: TaskSpec[]): Promise<void> {
  const allTaskIds = new Set<number>();
  for (const spec of specs) for (const id of spec.dependsOnTaskId ?? []) allTaskIds.add(id);
  if (allTaskIds.size === 0) return;

  const existingIds = await readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(`UNWIND $taskIds AS taskId MATCH (t:Task {id: taskId}) RETURN t.id AS id`, {
      taskIds: Array.from(allTaskIds),
    });
    return new Set(result.records.map((r) => r.get("id") as number));
  });

  const missing = Array.from(allTaskIds).filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new Error(`dependsOnTaskId refers to nonexistent task id(s): ${missing.join(", ")}.`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseCliArgs();

  if (args.help || (!args.file && !args.json)) {
    console.log(HELP_TEXT);
    process.exit(args.help ? 0 : 1);
  }

  let rawJson: string;
  if (args.file) {
    rawJson = readFileSync(args.file, "utf-8");
  } else if (args.json) {
    rawJson = args.json;
  } else {
    // Unreachable — guarded above — but keeps TS's definite-assignment check happy.
    console.log(HELP_TEXT);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    console.error("Failed to parse input JSON:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  let specs: TaskSpec[];
  try {
    specs = validateSpecs(parsed);
  } catch (err) {
    console.error("Validation error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const driver = await tryConnect();
  if (!driver) {
    console.error("Failed to connect to Neo4j — check backend/.env.");
    process.exit(1);
  }

  try {
    await validateTabsExist(specs);
    await validateDependencyTasksExist(specs);
  } catch (err) {
    console.error("Validation error:", err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  }

  const createdIds: number[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const dependsOn = [
      ...(spec.dependsOnBatchIndex ?? []).map((idx) => createdIds[idx]),
      ...(spec.dependsOnTaskId ?? []),
    ];

    const input: CreateTaskInput = {
      title: spec.title,
      type: spec.type,
      priority: spec.priority,
      tabIds: spec.tabIds,
      description: spec.description,
      files: spec.files,
      origin: spec.origin ?? "user-assisted", // convention default — see task-origin-convention.md
      groupId: spec.groupId,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    };

    try {
      const task = await createTask(input);
      createdIds.push(task.id);
      console.log(`Created task ${task.id}: ${task.title}`);
    } catch (err) {
      console.error(
        `Failed to create task at index ${i} ("${spec.title}"): ${err instanceof Error ? err.message : err}`
      );
      console.error(`Tasks already created before this failure: ${createdIds.join(", ") || "(none)"}`);
      await closePool();
      process.exit(1);
    }
  }

  console.log(`\nCreated ${createdIds.length} task(s). IDs: ${createdIds.join(", ")}`);
  for (let i = 0; i < specs.length; i++) {
    const batchDeps = (specs[i].dependsOnBatchIndex ?? []).map((idx) => createdIds[idx]);
    const idDeps = specs[i].dependsOnTaskId ?? [];
    const allDeps = [...batchDeps, ...idDeps];
    if (allDeps.length > 0) {
      console.log(`  Task ${createdIds[i]} depends on: ${allDeps.join(", ")}`);
    }
  }

  await closePool();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
