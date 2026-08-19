import { useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch, formatErrorTime } from '../utils/api';

export function ErrorsPanel() {
  const { errors, setErrors, fetchErrors } = useApp();

  useEffect(() => {
    fetchErrors();
  }, [fetchErrors]);

  const handleClearAll = async () => {
    try {
      const res = await apiFetch('/api/errors', { method: 'DELETE' });
      if (!res.ok) return;
      setErrors([]);
    } catch (e) {
      console.error('Failed to clear errors:', e);
    }
  };

  const handleDismiss = async (errorId: number) => {
    try {
      const res = await apiFetch(`/api/errors/${errorId}`, { method: 'DELETE' });
      if (!res.ok) return;
      setErrors(prev => prev.filter(e => e.id !== errorId));
    } catch (e) {
      console.error('Failed to dismiss error:', e);
    }
  };

  const handleCreateBugTask = async (errorId: number) => {
    try {
      const res = await apiFetch(`/api/errors/${errorId}/create-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        const data = await res.json();
        alert(data.error || 'Bug task already created for this error.');
        return;
      }
      if (!res.ok) return;
      const { task, errorId: eid } = await res.json();
      setErrors(prev => prev.map(e => e.id === eid ? { ...e, taskCreated: true, createdTaskId: task.id } : e));
    } catch (e) {
      console.error('Failed to create bug task:', e);
    }
  };

  return (
    <section id="panel-errors" role="tabpanel" aria-labelledby="tab-errors">
      <div className="errors-layout">
        <div className="errors-toolbar">
          <h2 className="errors-heading">Agent Errors</h2>
          <button className="btn btn-danger btn-sm" onClick={handleClearAll}>Clear All</button>
        </div>
        <div className="errors-list" id="errorsList">
          {errors.length === 0 ? (
            <div className="errors-empty" id="errorsEmpty">
              <p>No agent errors recorded. Errors will appear here when an AI agent encounters a problem during task execution.</p>
            </div>
          ) : (
            errors.map(error => (
              <div key={error.id} className="error-card" data-error-id={error.id}>
                <div className="error-card-header">
                  <span className="error-card-message">{error.message}</span>
                  <span className="error-card-time">{formatErrorTime(error.timestamp)}</span>
                </div>
                <div className="error-card-meta">
                  <span className="error-meta-item">🤖 {error.agent}</span>
                  <span className="error-meta-item">📡 {error.sessionName}</span>
                  {error.taskTitle && (
                    <span className="error-meta-item">📋 Task #{error.taskId}: {error.taskTitle}</span>
                  )}
                </div>
                <div className="error-card-context">{error.context}</div>
                <div className="error-card-actions">
                  {error.taskCreated ? (
                    <span className="error-task-created">✓ Bug task #{error.createdTaskId || '?'} created</span>
                  ) : (
                    <button className="btn btn-primary btn-sm error-create-task-btn" onClick={() => handleCreateBugTask(error.id)}>🐛 Create Bug Task</button>
                  )}
                  <button className="btn btn-sm error-dismiss-btn" onClick={() => handleDismiss(error.id)} title="Dismiss this error">✕ Dismiss</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
