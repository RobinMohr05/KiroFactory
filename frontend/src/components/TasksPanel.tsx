import { useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
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

export function TasksPanel() {
  const { tasks, setTasks, currentSort, setCurrentSort, currentTabId, fetchTabTasks, pendingOps } = useApp();
  const [editingTask, setEditingTask] = useState<Task | null | undefined>(undefined);
  // undefined = no modal, null = create new, Task = editing

  const sortedTasks = useCallback((state: TaskState) => {
    const columnTasks = tasks.filter(t => t.state === state);
    columnTasks.sort((a, b) => {
      switch (currentSort) {
        case 'updated':
          return new Date(b.updatedAt || '0').getTime() - new Date(a.updatedAt || '0').getTime();
        case 'created':
          return new Date(b.createdAt || '0').getTime() - new Date(a.createdAt || '0').getTime();
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
      const res = await fetch(`/api/tasks/${taskId}`, {
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
        <button className="btn btn-primary" id="newTaskBtn" onClick={() => setEditingTask(null)}>+ Task</button>
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
      </div>

      <div className="kanban">
        {COLUMNS.map(({ state, label }) => {
          const columnTasks = sortedTasks(state);
          return (
            <div
              key={state}
              className="column"
              data-state={state}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('drag-over'); }}
              onDrop={(e) => { e.currentTarget.classList.remove('drag-over'); handleDrop(e, state); }}
            >
              <div className="column-header">
                <h2>{label}</h2>
                <span className="column-count" id={`count-${state}`}>{columnTasks.length}</span>
              </div>
              <div className="column-cards" id={`cards-${state}`}>
                {columnTasks.map(task => (
                  <TaskCard key={task.id} task={task} onClick={() => setEditingTask(task)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {editingTask !== undefined && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(undefined)} />
      )}
    </section>
  );
}
