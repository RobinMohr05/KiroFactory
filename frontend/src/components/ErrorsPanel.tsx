import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch, formatErrorTime } from '../utils/api';
import { WslDiagnosticsPanel } from './WslDiagnosticsPanel';
import type { AgentError } from '../types';

type ErrorsSubTab = 'agent-errors' | 'wsl-docker-logs';

export function ErrorsPanel() {
  const { errors, setErrors, fetchErrors } = useApp();
  const [subTab, setSubTab] = useState<ErrorsSubTab>('agent-errors');

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

  const handleDismiss = async (errorId: string) => {
    try {
      const res = await apiFetch(`/api/errors/${errorId}`, { method: 'DELETE' });
      if (!res.ok) return;
      setErrors(prev => prev.filter(e => e.id !== errorId));
    } catch (e) {
      console.error('Failed to dismiss error:', e);
    }
  };

  const handleCreateBugTask = async (errorId: string) => {
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

  const handleCopyErrorDetail = async (error: AgentError) => {
    const parts = [
      `${error.message}`,
      `Context: ${error.context}`,
      `Agent: ${error.agent} | Session: ${error.sessionName}${error.taskTitle ? ` | Task #${error.taskId}: ${error.taskTitle}` : ''}`,
      `Time: ${error.timestamp}`,
    ];
    if (error.turnNumber !== undefined) parts.push(`Turn: ${error.turnNumber}, tool calls: ${error.toolCallCount ?? 0}, ${Math.round((error.turnDurationMs ?? 0) / 1000)}s into turn`);
    if (error.recentOutput?.length) {
      parts.push('--- Recent session output ---');
      parts.push(error.recentOutput.map(l => `[${l.timestamp}] [${l.stream}] ${l.text}`).join('\n'));
    }
    if (error.stack) {
      parts.push('--- Stack trace ---');
      parts.push(error.stack);
    }
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
    } catch (e) {
      console.error('Failed to copy error detail:', e);
    }
  };

  return (
    <section id="panel-errors" role="tabpanel" aria-labelledby="tab-errors">
      <div className="errors-layout">
        <div className="errors-toolbar">
          <h2 className="errors-heading">
            {subTab === 'agent-errors' ? 'Agent Errors' : 'WSL/Docker Logs'}
          </h2>
          {subTab === 'agent-errors' && (
            <button className="btn btn-danger btn-sm" onClick={handleClearAll}>Clear All</button>
          )}
        </div>
        <div className="errors-subtabs" role="tablist" aria-label="Errors view">
          <button
            className={`errors-subtab-btn ${subTab === 'agent-errors' ? 'active' : ''}`}
            role="tab"
            aria-selected={subTab === 'agent-errors'}
            onClick={() => setSubTab('agent-errors')}
          >
            Agent Errors
          </button>
          <button
            className={`errors-subtab-btn ${subTab === 'wsl-docker-logs' ? 'active' : ''}`}
            role="tab"
            aria-selected={subTab === 'wsl-docker-logs'}
            onClick={() => setSubTab('wsl-docker-logs')}
          >
            WSL/Docker Logs
          </button>
        </div>
        {subTab === 'agent-errors' ? (
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
                    {error.turnNumber !== undefined && (
                      <span className="error-meta-item">🔄 Turn {error.turnNumber}</span>
                    )}
                    {error.toolCallCount !== undefined && (
                      <span className="error-meta-item">🔧 {error.toolCallCount} tool call{error.toolCallCount === 1 ? '' : 's'}</span>
                    )}
                    {error.turnDurationMs !== undefined && (
                      <span className="error-meta-item">⏱ {Math.round(error.turnDurationMs / 1000)}s into turn</span>
                    )}
                  </div>
                  <div className="error-card-context">{error.context}</div>
                  {(error.recentOutput?.length || error.stack) && (
                    <details className="error-card-details">
                      <summary>Show diagnostic detail (recent session output{error.stack ? ' + stack trace' : ''})</summary>
                      {error.recentOutput && error.recentOutput.length > 0 && (
                        <pre className="error-recent-output">
                          {error.recentOutput.map(line => `[${formatErrorTime(line.timestamp)}] [${line.stream}] ${line.text}`).join('\n')}
                        </pre>
                      )}
                      {error.stack && (
                        <pre className="error-stack-trace">{error.stack}</pre>
                      )}
                      <button
                        className="btn btn-sm error-copy-detail-btn"
                        onClick={() => handleCopyErrorDetail(error)}
                      >
                        📋 Copy full detail
                      </button>
                    </details>
                  )}
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
        ) : (
          <WslDiagnosticsPanel />
        )}
      </div>
    </section>
  );
}
