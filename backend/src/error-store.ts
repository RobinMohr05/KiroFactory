/**
 * Error Store — In-memory storage for AI agent errors.
 *
 * Captures errors that occur during agent session execution, along with
 * context about what was happening when the error occurred (session, task, etc.).
 *
 * Errors are stored in memory and broadcast via WebSocket so the UI can
 * display them and allow one-click bug task creation.
 */

import { randomBytes } from "node:crypto";
import { broadcastToUser } from "./websocket-handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentError {
  id: string;
  sessionId: number;
  sessionName: string;
  agent: string;
  timestamp: string;
  message: string;
  /** What the agent was doing when the error occurred */
  context: string;
  /** Task ID if the error happened while working on a task */
  taskId?: number;
  /** Task title for display purposes */
  taskTitle?: string;
  /** Whether a bug task has already been created from this error */
  taskCreated: boolean;
  /** The ID of the bug task created from this error (if any) */
  createdTaskId?: number;
  /** Tab IDs this error is associated with (inherited from session at time of error) */
  tabIds?: number[];
  /** Owner user ID — errors belong to the account that owns the session */
  userId: number;
}

export interface RecordErrorInput {
  sessionId: number;
  sessionName: string;
  agent: string;
  message: string;
  context: string;
  taskId?: number;
  taskTitle?: string;
  /** Tab IDs this error is associated with (inherited from session) */
  tabIds?: number[];
  /** Owner user ID — inherited from the session that produced the error */
  userId: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_ERRORS = 200;
const errors: AgentError[] = [];

function generateId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Record a new agent error.
 */
export function recordError(input: RecordErrorInput): AgentError {
  const error: AgentError = {
    id: generateId(),
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    agent: input.agent,
    timestamp: new Date().toISOString(),
    message: input.message,
    context: input.context,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    taskCreated: false,
    tabIds: input.tabIds,
    userId: input.userId,
  };

  errors.unshift(error); // newest first

  // Cap the store size
  if (errors.length > MAX_ERRORS) {
    errors.length = MAX_ERRORS;
  }

  // Broadcast only to the account that owns the session this error came from
  broadcastToUser(error.userId, { type: "error-created", error });

  return error;
}

/**
 * Get all recorded errors (newest first).
 */
export function getAllErrors(): AgentError[] {
  return errors;
}

/**
 * Get all errors belonging to a specific user (newest first).
 */
export function getErrorsByUserId(userId: number): AgentError[] {
  return errors.filter((e) => e.userId === userId);
}

/**
 * Get a specific error by ID.
 */
export function getErrorById(id: string): AgentError | undefined {
  return errors.find((e) => e.id === id);
}

/**
 * Mark an error as having a bug task created from it.
 */
export function markErrorTaskCreated(errorId: string, taskId: number): void {
  const error = errors.find((e) => e.id === errorId);
  if (error) {
    error.taskCreated = true;
    error.createdTaskId = taskId;
  }
}

/**
 * Clear all errors for a specific user.
 */
export function clearErrorsByUserId(userId: number): void {
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].userId === userId) {
      errors.splice(i, 1);
    }
  }
}

/**
 * Clear all errors.
 */
export function clearErrors(): void {
  errors.length = 0;
}
