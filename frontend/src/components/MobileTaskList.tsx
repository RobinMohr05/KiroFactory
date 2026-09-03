import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { Task, TaskState } from '../types';

const COLUMNS: { state: TaskState; label: string }[] = [
  { state: 'todo', label: 'todo' },
  { state: 'in-progress', label: 'in-progress' },
  { state: 'developed', label: 'developed' },
  { state: 'in-code-review', label: 'in-code-review' },
  { state: 'reviewed', label: 'reviewed' },
  { state: 'in-qa', label: 'in-qa' },
  { state: 'done', label: 'done' },
];

const DEFAULT_ACTIVE_STATES = new Set<TaskState>([
  'todo', 'in-progress', 'developed', 'in-code-review', 'reviewed', 'in-qa',
]);

type SortOption = 'priority' | 'created' | 'alphabetical';

interface MobileTaskListProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function MobileTaskList({ tasks, onTaskClick }: MobileTaskListProps) {
  const [activeStates, setActiveStates] = useState<Set<TaskState>>(new Set(DEFAULT_ACTIVE_STATES));
  const [sortBy, setSortBy] = useState<SortOption>('priority');
  const [showSortPopover, setShowSortPopover] = useState(false);
  const sortContainerRef = useRef<HTMLDivElement>(null);

  // Click-outside dismissal for sort popover
  useEffect(() => {
    if (!showSortPopover) return;
    const handler = (e: MouseEvent) => {
      if (sortContainerRef.current && !sortContainerRef.current.contains(e.target as Node)) {
        setShowSortPopover(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [showSortPopover]);

  const toggleState = useCallback((state: TaskState) => {
    setActiveStates(prev => {
      const next = new Set(prev);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
  }, []);

  const taskCountByState = useMemo(() => {
    const counts = new Map<TaskState, number>();
    for (const col of COLUMNS) {
      counts.set(col.state, tasks.filter(t => t.state === col.state).length);
    }
    return counts;
  }, [tasks]);

  const filteredAndSorted = useMemo(() => {
    const filtered = tasks.filter(t => activeStates.has(t.state));
    const sorted = [...filtered];
    switch (sortBy) {
      case 'priority':
        sorted.sort((a, b) => (a.priority || 4) - (b.priority || 4));
        break;
      case 'created':
        sorted.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        break;
      case 'alphabetical':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return sorted;
  }, [tasks, activeStates, sortBy]);

  const handleSortSelect = (option: SortOption) => {
    setSortBy(option);
    setShowSortPopover(false);
  };

  return (
    <div className="mobile-task-list">
      <div className="mobile-task-list-controls">
        <div className="mobile-filter-chips" role="group" aria-label="Status filters">
          {COLUMNS.map(({ state, label }) => (
            <button
              key={state}
              className={`mobile-filter-chip${activeStates.has(state) ? ' active' : ''}`}
              aria-pressed={activeStates.has(state)}
              onClick={() => toggleState(state)}
            >
              {label}
              <span className="mobile-filter-chip-count">{taskCountByState.get(state) || 0}</span>
            </button>
          ))}
        </div>
        <div className="mobile-sort-container" ref={sortContainerRef}>
          <button
            className="mobile-sort-btn"
            aria-label="Sort"
            aria-haspopup="true"
            aria-expanded={showSortPopover}
            onClick={() => setShowSortPopover(prev => !prev)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M6 12h12M9 18h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          {showSortPopover && (
            <div className="mobile-sort-popover" role="menu">
              <button
                role="menuitem"
                className={`mobile-sort-option${sortBy === 'priority' ? ' active' : ''}`}
                aria-label="Priority"
                onClick={() => handleSortSelect('priority')}
              >
                Priority
              </button>
              <button
                role="menuitem"
                className={`mobile-sort-option${sortBy === 'created' ? ' active' : ''}`}
                aria-label="Created date"
                onClick={() => handleSortSelect('created')}
              >
                Created date
              </button>
              <button
                role="menuitem"
                className={`mobile-sort-option${sortBy === 'alphabetical' ? ' active' : ''}`}
                aria-label="Alphabetical"
                onClick={() => handleSortSelect('alphabetical')}
              >
                Alphabetical
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="mobile-task-list-cards">
        {filteredAndSorted.length === 0 ? (
          <p className="mobile-task-list-empty">No tasks match the selected filters.</p>
        ) : (
          filteredAndSorted.map(task => (
            <MobileTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />
          ))
        )}
      </div>
    </div>
  );
}

const TYPE_LABELS: Record<string, string> = {
  bug: 'Bug',
  feature: 'Feature',
  improvement: 'Improvement',
};

const TYPE_CLASSES: Record<string, string> = {
  bug: 'badge-bug',
  feature: 'badge-feature',
  improvement: 'badge-improvement',
};

function MobileTaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const priority = task.priority || 4;
  const typeLabel = TYPE_LABELS[task.type] || 'Task';
  const typeClass = TYPE_CLASSES[task.type] || 'badge-improvement';
  const blockedTitles = (task.blockedBy || []).map(b => b.title).join(', ');

  return (
    <div
      className={`mobile-task-card${task.isBlocked ? ' blocked' : ''}`}
      data-priority={priority}
      data-blocked={task.isBlocked ? 'true' : 'false'}
      role="article"
      aria-label={`Task: ${task.title}${task.isBlocked ? ' (blocked)' : ''}`}
      onClick={onClick}
    >
      <div className="mobile-task-card-priority" data-priority={priority} />
      <div className="mobile-task-card-content">
        <div className="mobile-task-card-title">{task.title}</div>
        <div className="mobile-task-card-meta">
          <span className={`badge badge-status`}>{task.state}</span>
          <span className={`badge ${typeClass}`}>{typeLabel}</span>
          {task.isBlocked && (
            <span className="badge badge-blocked" title={`Blocked by: ${blockedTitles}`}>⛔ Blocked</span>
          )}
          {task.groupId && (
            <span className="badge badge-group" title={`Shares a branch/PR with group "${task.groupId}"`}>🔗 {task.groupId}</span>
          )}
        </div>
      </div>
    </div>
  );
}
