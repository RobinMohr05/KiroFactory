import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import type { Task } from '../types';

interface TaskModalProps {
  task: Task | null; // null = creating new task
  onClose: () => void;
}

export function TaskModal({ task, onClose }: TaskModalProps) {
  const { setTasks, currentTabId, pendingOps } = useApp();
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [type, setType] = useState(task?.type || 'improvement');
  const [priority, setPriority] = useState(String(task?.priority || 4));
  const [state, setState] = useState(task?.state || 'todo');
  const [branch, setBranch] = useState(task?.branch || '');
  const [pullRequestUrl, setPullRequestUrl] = useState(task?.pullRequestUrl || '');
  const [error, setError] = useState('');

  const isEditing = !!task;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError('');

    try {
      if (isEditing) {
        const res = await fetch(`/api/tasks/${task.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            type,
            priority: parseInt(priority, 10),
            state,
            branch: branch.trim() || null,
            pullRequestUrl: pullRequestUrl.trim() || null,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
        }
        const updated = await res.json();
        pendingOps.current.add(`task-updated-${updated.id}`);
        setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
      } else {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            type,
            priority: parseInt(priority, 10),
            tabIds: currentTabId ? [currentTabId] : [],
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
        }
        const created = await res.json();
        pendingOps.current.add(`task-created-${created.id}`);
        setTasks(prev => [...prev, created]);
      }
      onClose();
    } catch (err: any) {
      setError(err.status === 409
        ? (err.message || 'This dependency would create a cycle.')
        : 'Failed to save task. Please try again.');
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (!res.ok) return;
      pendingOps.current.add(`task-deleted-${task.id}`);
      setTasks(prev => prev.filter(t => t.id !== task.id));
      onClose();
    } catch (e) {
      console.error('Failed to delete task:', e);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide" role="dialog" aria-labelledby="modalTitle">
        <h2 id="modalTitle">{isEditing ? 'Edit Task' : 'New Task'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="taskTitle">Title</label>
            <input type="text" id="taskTitle" required placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label htmlFor="taskDescription">Description</label>
            <textarea id="taskDescription" rows={3} placeholder="Optional description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="taskType">Type</label>
              <select id="taskType" value={type} onChange={(e) => setType(e.target.value as Task['type'])}>
                <option value="improvement">Improvement</option>
                <option value="bug">Bug</option>
                <option value="feature">Feature</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="taskPriority">Priority</label>
              <select id="taskPriority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="1">P1 — Critical</option>
                <option value="2">P2 — High</option>
                <option value="3">P3 — Medium</option>
                <option value="4">P4 — Low</option>
              </select>
            </div>
          </div>
          {isEditing && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="taskState">State</label>
                  <select id="taskState" value={state} onChange={(e) => setState(e.target.value as Task['state'])}>
                    <option value="todo">To Do</option>
                    <option value="in-progress">In Progress</option>
                    <option value="developed">Developed</option>
                    <option value="in-code-review">In Code Review</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="in-qa">In QA</option>
                    <option value="done">Done</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="taskBranch">Branch</label>
                  <input type="text" id="taskBranch" placeholder="No branch yet" value={branch} onChange={(e) => setBranch(e.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor="taskPullRequestUrl">Pull Request URL</label>
                  <input type="text" id="taskPullRequestUrl" placeholder="No PR yet" value={pullRequestUrl} onChange={(e) => setPullRequestUrl(e.target.value)} />
                </div>
              </div>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            {isEditing && <button type="button" className="btn btn-danger" onClick={handleDelete}>Delete</button>}
            <div className="form-actions-right">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary">{isEditing ? 'Update Task' : 'Create Task'}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
