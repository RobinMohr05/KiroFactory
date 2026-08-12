import { Router, type Request, type Response } from "express";
import {
  createSession,
  startSession,
  stopSession,
  sendPrompt,
  getSession,
  getSessionOutput,
  deleteSession,
} from "../session-manager.js";
import { createTask } from "../db/tasks.js";
import { getAllTabs, getTabById } from "../db/tabs.js";
import { broadcastToUser } from "../websocket-handler.js";
import { notifyTaskAvailable } from "../agent/task-claimer.js";
import { requireAuth, getUserId } from "../middleware/auth.js";
import { log, toErrorFields } from "../logger.js";
import { getDecryptedCredential } from "../db/credentials.js";
import { resolveGitProvider } from "../types.js";
import { getUserById } from "../db/users.js";
import { preparePlannerWorkspace, cleanupPlannerWorkspace } from "../agent/planner-workspace.js";
import type { CreateTaskInput } from "../types.js";

const router = Router();

// All task planner routes require authentication
router.use(requireAuth);

/**
 * Tracks the temporary workspace path for each planner session,
 * so it can be cleaned up when the session is closed/deleted.
 */
const plannerWorkspaces = new Map<number, string>();

/**
 * System prompt for the task planner agent.
 * This instructs the AI to help the user define a well-structured task
 * through a conversational interview process.
 */
const TASK_PLANNER_SYSTEM_PROMPT = `You are a Task Planner assistant. Your job is to help the user create a well-designed, actionable task for a software development team.

## Your Process

1. **Understand the idea**: Ask the user what they want to accomplish. Listen carefully.
2. **Clarify requirements**: Ask targeted follow-up questions to understand:
   - What exactly should change or be built?
   - Why is this needed? What problem does it solve?
   - Are there specific files, components, or areas of the codebase involved?
   - What's the expected behavior when this is done?
   - Are there edge cases or constraints to consider?
3. **Propose the task**: Once you have enough information, propose a well-structured task with:
   - A clear, concise title (action-oriented, e.g., "Add pagination to /users endpoint")
   - A detailed description that includes acceptance criteria
   - Suggested priority (1=Critical, 2=High, 3=Medium, 4=Low)
   - Suggested type (feature, improvement, or bug)
   - Relevant files (if known)
4. **Refine**: Ask if the user wants to adjust anything about the proposal.
5. **Finalize**: When the user approves, output the final task as a JSON block.

## Rules

- Be conversational and helpful, not robotic.
- Ask ONE or TWO questions at a time, not a long list.
- If the user gives a vague idea, help them sharpen it.
- If the user gives a detailed spec, move quickly to the proposal.
- Always suggest a priority and type, but let the user override.
- Keep titles under 80 characters.
- Descriptions should be detailed enough for another developer to implement without further questions.

## Output Format

When the user confirms the task, output EXACTLY this format (and nothing else after it):

\`\`\`json:task
{
  "title": "...",
  "description": "...",
  "priority": 1-4,
  "type": "feature|improvement|bug",
  "files": ["file1.ts", "file2.ts"]
}
\`\`\`

Start by greeting the user and asking what they'd like to accomplish.`;

// POST /api/task-planner/start — Start a new task planning conversation
router.post("/start", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { tabId } = req.body as { tabId?: number };

    // Build the system prompt, optionally enriched with tab/repository context
    let systemPrompt = TASK_PLANNER_SYSTEM_PROMPT;
    let sessionTabIds: number[] | undefined;
    let sessionCwd: string | undefined;

    if (tabId) {
      const tab = await getTabById(tabId);
      if (tab && tab.userId === userId) {
        sessionTabIds = [tab.id];
        const contextLines: string[] = [
          `\n\n## Repository Context`,
          `You are planning a task for the following project:`,
          `- **Tab/Project name:** ${tab.name}`,
        ];
        if (tab.repositoryUrl) {
          contextLines.push(`- **Repository URL:** ${tab.repositoryUrl}`);
        }
        if (tab.gitProvider) {
          contextLines.push(`- **Git provider:** ${tab.gitProvider}`);
        }

        // Clone the repository so the planner can read actual files
        if (tab.repositoryUrl) {
          const owner = await getUserById(userId);
          const provider = resolveGitProvider(
            tab.gitProvider,
            owner?.defaultGitProvider,
            tab.repositoryUrl
          );

          // Retrieve the appropriate PAT for private repos
          let githubPat: string | undefined;
          let azureDevOpsPat: string | undefined;
          if (provider === "github") {
            const pat = await getDecryptedCredential(userId, "githubPat");
            if (pat) githubPat = pat;
          } else if (provider === "azure-devops") {
            const pat = await getDecryptedCredential(userId, "azureDevOpsPat");
            if (pat) azureDevOpsPat = pat;
          }

          const workspace = await preparePlannerWorkspace({
            repositoryUrl: tab.repositoryUrl,
            gitProvider: provider,
            githubPat,
            azureDevOpsPat,
          });

          if (workspace) {
            sessionCwd = workspace.workspacePath;
            contextLines.push(
              `\n**You have full read access to this repository's files.** ` +
              `Use your file reading tools (readFile, listDirectory, etc.) to browse the codebase. ` +
              `Read README.md, any SPEC.md or architecture docs, and browse the file tree to understand ` +
              `the project structure before proposing tasks. Reference actual file paths that exist in the repo.`
            );
          }
        }

        contextLines.push(
          `\nUse this context to ask more relevant clarifying questions and suggest accurate file paths. ` +
          `When proposing the task, ground your suggestions in this specific project.`
        );
        systemPrompt += contextLines.join("\n");
      }
    }

    // Create a dedicated interactive session for this planning conversation
    const session = await createSession({
      name: "Task Planner",
      prompt: systemPrompt,
      interactive: true,
      loop: false,
      runs: 0,
      intervalSeconds: 0,
      userId,
      tabIds: sessionTabIds,
      pinned: false,
      cwd: sessionCwd,
    });

    // Track workspace path for cleanup when the session ends
    if (sessionCwd) {
      plannerWorkspaces.set(session.id, sessionCwd);
    }

    // Start the session immediately
    await startSession(session.id);

    res.status(201).json({
      sessionId: session.id,
      message: "Task planner session started",
    });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/start",
      ...toErrorFields(err),
      msg: "Failed to start task planner",
    });
    res.status(500).json({ error: "Failed to start task planner" });
  }
});

// POST /api/task-planner/:sessionId/message — Send a message to the task planner
router.post("/:sessionId/message", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    const { message } = req.body as { message: string };
    if (!message || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const sent = await sendPrompt(sessionId, message.trim());
    if (!sent) {
      res.status(400).json({ error: "Could not send message — session may not be running" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/:sessionId/message",
      ...toErrorFields(err),
      msg: "Failed to send task planner message",
    });
    res.status(500).json({ error: "Failed to send message" });
  }
});

// POST /api/task-planner/:sessionId/create-task — Create the task from the conversation
router.post("/:sessionId/create-task", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    // Accept task data from the frontend (parsed from the AI output)
    const { title, description, priority, type, files, tabIds } = req.body as {
      title: string;
      description: string;
      priority: number;
      type: string;
      files?: string[];
      tabIds?: number[];
    };

    if (!title || !priority || !type) {
      res.status(400).json({ error: "title, priority, and type are required" });
      return;
    }

    // Verify tabIds belong to the user if provided
    let finalTabIds = tabIds;
    if (finalTabIds && finalTabIds.length > 0) {
      const userTabs = await getAllTabs(userId);
      const userTabIds = new Set(userTabs.map((t) => t.id));
      const unauthorized = finalTabIds.filter((id) => !userTabIds.has(id));
      if (unauthorized.length > 0) {
        res.status(403).json({ error: "Cannot assign task to tabs you do not own" });
        return;
      }
    } else {
      // Prefer the tab that was used to start the planning session
      if (session.tabIds && session.tabIds.length > 0) {
        finalTabIds = session.tabIds;
      } else {
        // Fallback to user's first tab
        const userTabs = await getAllTabs(userId);
        if (userTabs.length > 0) {
          finalTabIds = [userTabs[0].id];
        }
      }
    }

    const taskInput: CreateTaskInput = {
      title,
      description: description || "",
      priority: priority as 1 | 2 | 3 | 4,
      type: type as "feature" | "improvement" | "bug",
      files: files || [],
      origin: "user-assisted",
      tabIds: finalTabIds,
    };

    const task = await createTask(taskInput);
    broadcastToUser(userId, { type: "task-created", task });
    notifyTaskAvailable(); // wake any idle loop sessions immediately

    // Clean up the planner session
    try {
      await stopSession(sessionId);
      deleteSession(sessionId);
    } catch {
      // Non-fatal — session cleanup failure doesn't affect the created task
    }

    // Clean up the cloned workspace
    const workspacePath = plannerWorkspaces.get(sessionId);
    if (workspacePath) {
      plannerWorkspaces.delete(sessionId);
      cleanupPlannerWorkspace(workspacePath).catch(() => {
        // Non-fatal — workspace cleanup runs in background
      });
    }

    res.status(201).json(task);
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "POST",
      path: "/api/task-planner/:sessionId/create-task",
      ...toErrorFields(err),
      msg: "Failed to create task from planner",
    });
    res.status(500).json({ error: "Failed to create task" });
  }
});

// DELETE /api/task-planner/:sessionId — Cancel/close a task planner session
router.delete("/:sessionId", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    await stopSession(sessionId);
    deleteSession(sessionId);

    // Clean up the cloned workspace
    const workspacePath = plannerWorkspaces.get(sessionId);
    if (workspacePath) {
      plannerWorkspaces.delete(sessionId);
      cleanupPlannerWorkspace(workspacePath).catch(() => {
        // Non-fatal — workspace cleanup runs in background
      });
    }

    res.status(204).send();
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "DELETE",
      path: "/api/task-planner/:sessionId",
      ...toErrorFields(err),
      msg: "Failed to delete task planner session",
    });
    res.status(500).json({ error: "Failed to close task planner" });
  }
});

// GET /api/task-planner/:sessionId/output — Get the conversation output
router.get("/:sessionId/output", (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const sessionId = Number(req.params.sessionId);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: "Task planner session not found" });
      return;
    }

    const output = getSessionOutput(sessionId);
    res.json({ entries: output || [] });
  } catch (err) {
    log.error("route-error", {
      component: "task-planner",
      method: "GET",
      path: "/api/task-planner/:sessionId/output",
      ...toErrorFields(err),
      msg: "Failed to get task planner output",
    });
    res.status(500).json({ error: "Failed to get output" });
  }
});

export default router;
