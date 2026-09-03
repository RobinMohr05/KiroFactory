import { useRef, useEffect } from 'react';
import type { Task } from '../types';
import { TYPE_CLASSES, ORIGIN_ICONS } from '../utils/api';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  highlighted?: boolean;
  disableInteraction?: boolean;
}

export function TaskCard({ task, onClick, highlighted, disableInteraction }: TaskCardProps) {
  const wasDragged = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll into view and flash when highlighted
  useEffect(() => {
    if (highlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlighted]);

  const typeClass = TYPE_CLASSES[task.type] || 'badge-improvement';
  const typeLabel = task.type ? task.type.charAt(0).toUpperCase() + task.type.slice(1) : 'Task';
  const originIcon = ORIGIN_ICONS[task.origin || 'user'] || '\u{1F464}';
  const priority = task.priority || 4;

  const blockedTitles = (task.blockedBy || []).map(b => b.title).join(', ');

  const handleDragStart = (e: React.DragEvent) => {
    wasDragged.current = true;
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('dragging');
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('dragging');
  };

  const handleClick = () => {
    if (wasDragged.current) {
      wasDragged.current = false;
      return;
    }
    onClick();
  };

  return (
    <div
      ref={cardRef}
      className={`task-card${highlighted ? ' task-card-highlighted' : ''}`}
      draggable={!disableInteraction}
      data-task-id={task.id}
      data-priority={priority}
      data-blocked={task.isBlocked ? 'true' : 'false'}
      role="article"
      aria-label={`Task: ${task.title}${task.isBlocked ? ' (blocked)' : ''}`}
      onDragStart={disableInteraction ? undefined : handleDragStart}
      onDragEnd={disableInteraction ? undefined : handleDragEnd}
      onClick={handleClick}
    >
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span className={`badge ${typeClass}`}>{typeLabel}</span>
        <span className="card-priority">P{priority}</span>
        {task.isBlocked && (
          <span className="badge badge-blocked" title={`Blocked by: ${blockedTitles}`}>⛔ Blocked</span>
        )}
        {task.groupId && (
          <span className="badge badge-group" title={`Shares a branch/PR with group "${task.groupId}"`}>🔗 {task.groupId}</span>
        )}
        <span className="card-origin" title={task.origin || 'user'}>{originIcon}</span>
      </div>
    </div>
  );
}
