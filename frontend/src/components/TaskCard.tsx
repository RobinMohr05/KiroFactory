import { useRef } from 'react';
import type { Task } from '../types';
import { TYPE_CLASSES, ORIGIN_ICONS } from '../utils/api';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const wasDragged = useRef(false);

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
      className="task-card"
      draggable
      data-task-id={task.id}
      data-priority={priority}
      data-blocked={task.isBlocked ? 'true' : 'false'}
      role="article"
      aria-label={`Task: ${task.title}${task.isBlocked ? ' (blocked)' : ''}`}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
    >
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span className={`badge ${typeClass}`}>{typeLabel}</span>
        <span className="card-priority">P{priority}</span>
        {task.isBlocked && (
          <span className="badge badge-blocked" title={`Blocked by: ${blockedTitles}`}>⛔ Blocked</span>
        )}
        <span className="card-origin" title={task.origin || 'user'}>{originIcon}</span>
      </div>
    </div>
  );
}
