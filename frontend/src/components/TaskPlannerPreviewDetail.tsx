import { TYPE_CLASSES } from '../utils/api';
import type { ParsedTask } from './TaskPlannerModal';

interface TaskPlannerPreviewDetailProps {
  /** The full batch of parsed tasks being previewed. */
  tasks: ParsedTask[];
  /** Index of the currently shown task within `tasks`. */
  index: number;
  /** Change which task is shown (used by the prev/next paging arrows). */
  onIndexChange: (newIndex: number) => void;
  /** Close the panel (only invoked by the ✕ button — there is no backdrop). */
  onClose: () => void;
}

/**
 * A read-only, NON-modal floating panel that shows the details of a single
 * parsed (but not-yet-created) task from the AI Task Planner's preview batch.
 *
 * Unlike TaskModal/TabModal, this is deliberately NOT a `.modal-backdrop`
 * overlay: it's absolutely positioned within TaskPlannerModal's own container
 * so it covers only the messages area, leaving the input row and action bar
 * (Send / Create Task) fully visible and clickable while it's open. There is
 * no backdrop and no click-outside-to-close — closing happens only via the ✕
 * button, so clicks elsewhere in the modal reach it normally.
 *
 * It renders raw draft data only — it does NOT fetch, resolve, or persist
 * anything (dependsOnBatchIndex/dependsOnTaskId/groupId are shown as raw
 * indices/IDs, not resolved task objects).
 */
export function TaskPlannerPreviewDetail({ tasks, index, onIndexChange, onClose }: TaskPlannerPreviewDetailProps) {
  const task = tasks[index];
  if (!task) return null;

  const typeClass = TYPE_CLASSES[task.type] || 'badge-improvement';
  const typeLabel = task.type ? task.type.charAt(0).toUpperCase() + task.type.slice(1) : 'Task';
  const priority = Number(task.priority) || 4;
  const multi = tasks.length > 1;

  return (
    <div className="task-planner-preview-detail" role="region" aria-label="Task preview details">
      <div className="task-planner-preview-detail-header">
        <div className="task-planner-preview-detail-nav">
          {multi && (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm preview-detail-arrow"
                aria-label="Previous task"
                disabled={index === 0}
                onClick={() => onIndexChange(index - 1)}
              >‹</button>
              <span className="preview-detail-counter">{index + 1} / {tasks.length}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm preview-detail-arrow"
                aria-label="Next task"
                disabled={index === tasks.length - 1}
                onClick={() => onIndexChange(index + 1)}
              >›</button>
            </>
          )}
        </div>
        <button
          type="button"
          className="preview-detail-close"
          aria-label="Close preview"
          onClick={onClose}
        >✕</button>
      </div>

      <div className="task-planner-preview-detail-body">
        <h3 className="preview-detail-title">{task.title}</h3>
        <div className="preview-detail-meta">
          <span className={`badge ${typeClass}`}>{typeLabel}</span>
          <span className="card-priority">P{priority}</span>
        </div>

        {task.description && (
          <p className="preview-detail-description">{task.description}</p>
        )}

        {task.files && task.files.length > 0 && (
          <div className="preview-detail-field">
            <span className="preview-detail-label">Files</span>
            <ul className="preview-detail-files">
              {task.files.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        {task.dependsOnBatchIndex && task.dependsOnBatchIndex.length > 0 && (
          <div className="preview-detail-field">
            <span className="preview-detail-label">Depends on batch index</span>
            <span className="preview-detail-value">{task.dependsOnBatchIndex.join(', ')}</span>
          </div>
        )}

        {task.dependsOnTaskId && task.dependsOnTaskId.length > 0 && (
          <div className="preview-detail-field">
            <span className="preview-detail-label">Depends on task ID</span>
            <span className="preview-detail-value">{task.dependsOnTaskId.join(', ')}</span>
          </div>
        )}

        {task.groupId && (
          <div className="preview-detail-field">
            <span className="preview-detail-label">Group ID</span>
            <span className="preview-detail-value">{task.groupId}</span>
          </div>
        )}
      </div>
    </div>
  );
}
