import { useState, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch, truncateUrl } from '../utils/api';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { TaskPlannerModal } from './TaskPlannerModal';
import { MobileTaskList } from './MobileTaskList';
import { useMobileBreakpoint } from '../hooks/useMobileBreakpoint';
import type { Task, TaskState } from '../types';

const COLUMNS: { state: TaskState; label: string }[] = [
  { state: 'todo', label: 'To Do' },
  { state: 'in-progress', label: 'In Progress' },
  { state: 'developed', label: 'Developed' },
  { state: 'in-code-review', label: 'In Code Review' },
  { state: 'reviewed', label: 'Reviewed' },
  { state: 'in-qa', label: 'In QA' },
  { state: 'done', label: 'Done' },
];

// Only these two columns can be collapsed to reduce horizontal scrolling on
// smaller-than-1440p displays. Kept as a global (not per-tab) preference.
const COLLAPSIBLE_STATES: TaskState[] = ['todo', 'done'];
const COLLAPSED_STORAGE_KEY = 'kanban-collapsed-columns';

function readCollapsedColumns(): TaskState[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is TaskState => COLLAPSIBLE_STATES.includes(s as TaskState));
  } catch {
    return [];
  }
}

export function TasksPanel() {
  const { tasks, setTasks, currentSort, setCurrentSort, currentTabId, tabs, fetchTabTasks, pendingOps, highlightedTaskId, setHighlightedTaskId } = useApp();
  const [editingTask, setEditingTask] = useState<Task | null | undefined>(undefined);
  const [showPlanner, setShowPlanner] = useState(false);
  const [collapsedColumns, setCollapsedColumns] = useState<TaskState[]>(() => readCollapsedColumns());
  const isMobile = useMobileBreakpoint();
  // undefined = no modal, null = create new, Task = editing

  // Persist collapsed-column preference globally (not per-tab) across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedColumns));
    } catch {
      /* ignore write failures (e.g. storage disabled) */
    }
  }, [collapsedColumns]);

  const toggleColumnCollapsed = useCallback((state: TaskState) => {
    setCollapsedColumns(prev =>
      prev.includes(state) ? prev.filter(s => s !== state) : [...prev, state]
    );
  }, []);

  // Auto-clear highlighted task after animation (2s)
  useEffect(() => {
    if (highlightedTaskId == null) return;
    const timer = setTimeout(() => setHighlightedTaskId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedTaskId, setHighlightedTaskId]);

  const currentTab = tabs.find(t => t.id === currentTabId);

  const sortedTasks = useCallback((state: TaskState) => {
    const columnTasks = tasks.filter(t => t.state === state);
    columnTasks.sort((a, b) => {
      switch (currentSort) {
        case 'updated':
          return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
        case 'created':
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        case 'priority':
        default:
          return (a.priority || 4) - (b.priority || 4);
      }
    });
    return columnTasks;
  }, [tasks, currentSort]);

  const handleDrop = useCallback(async (e: React.DragEvent, state: TaskState) => {
    e.preventDefault();
    const taskId = Number(e.dataTransfer.getData('text/plain'));
    if (!taskId) return;

    setTasks(prev => {
      const task = prev.find(t => t.id === taskId);
      if (!task || task.state === state) return prev;
      return prev.map(t => t.id === taskId ? { ...t, state } : t);
    });

    pendingOps.current.add(`task-updated-${taskId}`);
    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      if (!res.ok) {
        // Revert on error
        if (currentTabId) fetchTabTasks(currentTabId);
      }
    } catch {
      if (currentTabId) fetchTabTasks(currentTabId);
    }
  }, [setTasks, pendingOps, currentTabId, fetchTabTasks]);

  const handleRefresh = async () => {
    if (currentTabId) await fetchTabTasks(currentTabId);
  };

  return (
    <section id="panel-boards" role="tabpanel" aria-labelledby="tab-boards">
      <div className="toolbar">
        <button className="btn btn-primary" id="newTaskBtn" onClick={() => setShowPlanner(true)}>+ Task</button>
        <select
          id="taskSortSelect"
          className="sort-select"
          aria-label="Sort tasks by"
          value={currentSort}
          onChange={(e) => setCurrentSort(e.target.value as typeof currentSort)}
        >
          <option value="priority">Sort: Priority</option>
          <option value="updated">Sort: Last Edited</option>
          <option value="created">Sort: Created</option>
        </select>
        <button className="btn btn-secondary btn-sm" id="refreshTasksBtn" title="Refresh tasks" aria-label="Refresh tasks" onClick={handleRefresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M23 4v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 20v-6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        {currentTab?.repositoryUrl && (
          <div className="board-repo-indicator">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9z" fill="currentColor"/><path d="M6.25 1a.75.75 0 00-.75.75v5.5a.75.75 0 001.28.53L8 6.56l1.22 1.22a.75.75 0 001.28-.53v-5.5A.75.75 0 009.75 1h-3.5z" fill="currentColor"/></svg>
            <a href={currentTab.repositoryUrl} target="_blank" rel="noopener noreferrer" title={currentTab.repositoryUrl}>
              {truncateUrl(currentTab.repositoryUrl)}
            </a>
          </div>
        )}
      </div>

      {isMobile ? (
        <MobileTaskList tasks={tasks} onTaskClick={(task) => setEditingTask(task)} />
      ) : (
        <div
          className="kanban"
          style={{
            gridTemplateColumns: COLUMNS.map(({ state }) =>
              collapsedColumns.includes(state) ? 'min-content' : 'minmax(260px, 1fr)'
            ).join(' '),
          }}
        >
          {COLUMNS.map(({ state, label }) => {
            const columnTasks = sortedTasks(state);
            const collapsible = COLLAPSIBLE_STATES.includes(state);
            const collapsed = collapsible && collapsedColumns.includes(state);
            return (
              <div
                key={state}
                className={`column${collapsed ? ' column-collapsed' : ''}`}
                data-state={state}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('drag-over'); }}
                onDrop={(e) => { e.currentTarget.classList.remove('drag-over'); handleDrop(e, state); }}
              >
                <div className="column-header">
                  {collapsible && (
                    <button
                      type="button"
                      className="column-collapse-toggle"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label} column`}
                      title={`${collapsed ? 'Expand' : 'Collapse'} ${label} column`}
                      onClick={() => toggleColumnCollapsed(state)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  )}
                  <h2>{label}</h2>
                  <span className="column-count" id={`count-${state}`}>{columnTasks.length}</span>
                </div>
                {!collapsed && (
                  <div className="column-cards" id={`cards-${state}`}>
                    {columnTasks.map(task => (
                      <TaskCard key={task.id} task={task} onClick={() => setEditingTask(task)} highlighted={highlightedTaskId === task.id} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingTask !== undefined && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(undefined)} />
      )}

      {showPlanner && (
        <TaskPlannerModal onClose={() => setShowPlanner(false)} onSwitchToManual={() => setEditingTask(null)} />
      )}
    </section>
  );
}
