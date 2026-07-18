/**
 * Tracks task IDs that were recently broadcast by REST routes.
 * The poll loop checks this to avoid re-broadcasting the same changes,
 * which would cause duplicate items on the client.
 */

const recentlyBroadcastTaskIds = new Set<number>();
const BROADCAST_TRACK_TTL_MS = 5000; // Clear after 5s (3+ poll cycles)

/**
 * Mark a task ID as recently broadcast by a REST route.
 * The poll loop will skip this task for the next few seconds.
 */
export function markTaskBroadcast(taskId: number): void {
  recentlyBroadcastTaskIds.add(taskId);
  setTimeout(() => recentlyBroadcastTaskIds.delete(taskId), BROADCAST_TRACK_TTL_MS);
}

/**
 * Check if a task was recently broadcast by a REST route.
 */
export function wasRecentlyBroadcast(taskId: number): boolean {
  return recentlyBroadcastTaskIds.has(taskId);
}
