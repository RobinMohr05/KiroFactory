import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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

export function TasksPanel() {
  const { tasks, setTasks, currentSort, setCurrentSort, currentTabId, tabs, fetchTabTasks, pendingOps, boardSessions, boardAgents, setActiveSessionId, setActiveView, highlightedTaskId, setHighlightedTaskId } = useApp();
  const navigate = useNavigate();
  const [editingTask, setEditingTask] = useState<Task | null | undefined>(undefined);
  const [showPlanner, setShowPlanner] = useState(false);
  const isMobile = useMobileBreakpoint();
  // undefined = no modal, null = create new, Task = editing

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

  const handleSessionClick = (sessionId: number) => {
    setActiveSessionId(sessionId);
    navigate(`/sessions/${sessionId}`);
  };

  const handleAgentClick = (_agentName: string) => {
    navigate('/agents');
  };

  return (
    <section id="panel-boards" role="tabpanel" aria-labelledby="tab-boards">
      <div className="toolbar">
        <button className="btn btn-primary" id="newTaskBtn" onClick={() => setEditingTask(null)}>+ Task</button>
        <button className="btn btn-secondary btn-sm" id="aiPlannerBtn" onClick={() => setShowPlanner(true)} title="AI Task Planner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a2 2 0 110 4h-1a7 7 0 01-7 7h-1v1.27c.6.34 1 .99 1 1.73a2 2 0 11-4 0c0-.74.4-1.39 1-1.73V25h-1a7 7 0 01-7-7H3a2 2 0 110-4h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          AI Planner
        </button>
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
                    <TaskCard key={task.id} task={task} onClick={() => setEditingTask(task)} highlighted={highlightedTaskId === task.id} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(boardSessions.length > 0 || boardAgents.length > 0) && (
        <div className="board-members">
          <div className="board-members-section">
            <h4>Sessions <span className="column-count">{boardSessions.length}</span></h4>
            <div className="board-members-list" id="board-sessions-list">
              {boardSessions.length === 0 ? (
                <p className="board-members-empty">No sessions assigned to this board.</p>
              ) : (
                boardSessions.map(session => (
                  <div key={session.id} className="board-member-chip" style={{ cursor: 'pointer' }} onClick={() => handleSessionClick(session.id)}>
                    <span className={`chip-status status-${session.status}`}></span>
                    <span className="chip-name">{session.name}</span>
                    <span className="chip-detail">{session.agent || 'Interactive'} · {session.status}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="board-members-section">
            <h4>Agents <span className="column-count">{boardAgents.length}</span></h4>
            <div className="board-members-list" id="board-agents-list">
              {boardAgents.length === 0 ? (
                <p className="board-members-empty">No agents assigned to this board.</p>
              ) : (
                boardAgents.map((agentName, i) => {
                  const initials = (agentName || '?').substring(0, 2).toUpperCase();
                  return (
                    <div key={i} className="board-member-chip" style={{ cursor: 'pointer' }} onClick={() => handleAgentClick(agentName)}>
                      <span className="agent-item-icon" style={{ width: 24, height: 24, fontSize: '0.6rem', lineHeight: '24px' }}>{initials}</span>
                      <span className="chip-name">{agentName}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {editingTask !== undefined && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(undefined)} />
      )}

      {showPlanner && (
        <TaskPlannerModal onClose={() => setShowPlanner(false)} />
      )}
    </section>
  );
}
