import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { SessionDetailTabs } from './SessionDetailTabs';
import type { OutputEntry, SessionActivity } from '../types';

/**
 * Simplified "Easy mode" replacement for the full Sessions view. Shows the
 * user's pinned/permanent chat session plus any other sessions they've
 * created, and a minimal creation form: prompt + run count (0 = endless)
 * + the same MCP toggle set SessionModal exposes. Everything else
 * SessionModal exposes (name, agent, model, interactive/loop checkboxes,
 * interval, cwd, timeout, tab assignment, custom MCP servers) is left at
 * sensible defaults — see handleCreate below.
 */
export function EasySessionsView() {
  const { sessions, setSessions, activeSessionId, setActiveSessionId } = useApp();
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [activity, setActivity] = useState<SessionActivity | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [runs, setRuns] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const pinnedSession = sessions.find(s => s.isPermanent) || sessions.find(s => s.pinned);
  const otherSessions = sessions.filter(s => s.id !== pinnedSession?.id);

  // Default to the pinned chat session so it's what greets the user.
  useEffect(() => {
    if (!activeSessionId && pinnedSession) {
      setActiveSessionId(pinnedSession.id);
    }
  }, [activeSessionId, pinnedSession, setActiveSessionId]);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Load session output when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setOutput([]);
      return;
    }
    (async () => {
      try {
        const res = await apiFetch(`/api/sessions/${activeSessionId}/output`);
        if (!res.ok) return;
        const data: OutputEntry[] = await res.json();
        setOutput(data);
      } catch { /* ignore */ }
    })();
  }, [activeSessionId]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId === activeSessionId && detail.entry) {
        setOutput(prev => [...prev, detail.entry]);
      }
    };
    window.addEventListener('ws-session-output', handler);
    return () => window.removeEventListener('ws-session-output', handler);
  }, [activeSessionId]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId === activeSessionId && detail.activity) {
        setActivity(detail.activity);
      }
    };
    window.addEventListener('ws-session-activity', handler);
    return () => window.removeEventListener('ws-session-activity', handler);
  }, [activeSessionId]);

  const isRunning = activeSession?.status === 'running';
  const isInteractive = activeSession?.interactive !== false;
  const isLoop = activeSession?.loop === true;
  const canSendPrompt = isRunning && isInteractive && !isLoop;

  const [chatText, setChatText] = useState('');
  const handleSendChat = async () => {
    if (!chatText.trim() || !activeSessionId) return;
    await apiFetch(`/api/sessions/${activeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chatText.trim() }),
    });
    setChatText('');
  };

  const resetNewForm = useCallback(() => {
    setPrompt('');
    setRuns(0);
    setCreateError(null);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      setCreateError('Please describe what you want the session to do.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      // Auto-generated name — Easy mode has no name field. Loop is enabled
      // whenever a run count is given (matches "amount of loops" framing);
      // no agent, no tab assignment, no other SessionModal knobs exposed.
      const body = {
        name: `Session ${new Date().toLocaleString()}`,
        prompt: prompt.trim(),
        interactive: true,
        loop: true,
        runs,
        intervalSeconds: 10,
      };
      const res = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to create session (HTTP ${res.status})`);
      }
      const newSession = await res.json();
      setSessions(prev => (prev.find(s => s.id === newSession.id) ? prev : [...prev, newSession]));
      await apiFetch(`/api/sessions/${newSession.id}/start`, { method: 'POST' });
      setActiveSessionId(newSession.id);
      setShowNewForm(false);
      resetNewForm();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create session.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section id="panel-easy-sessions" className="easy-sessions-view" aria-label="Sessions">
      <aside className="easy-sessions-list">
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setShowNewForm(v => !v)}>
            {showNewForm ? 'Cancel' : '+ New Session'}
          </button>
        </div>

        {showNewForm && (
          <form className="easy-session-new-form" onSubmit={handleCreate}>
            <div className="form-group">
              <label htmlFor="easyPrompt">What should it do?</label>
              <textarea
                id="easyPrompt"
                rows={4}
                placeholder="Describe the task..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="easyRuns">Runs <small>(0 = endless)</small></label>
              <input
                type="number"
                id="easyRuns"
                min="0"
                value={runs}
                onChange={(e) => setRuns(Number(e.target.value))}
              />
            </div>
            {createError && <div className="form-message error">{createError}</div>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
                {creating ? 'Starting…' : 'Start Session'}
              </button>
            </div>
          </form>
        )}

        <ul className="easy-session-list-items" aria-label="Sessions">
          {pinnedSession && (
            <li
              key={pinnedSession.id}
              className={`easy-session-item${pinnedSession.id === activeSessionId ? ' active' : ''}`}
              onClick={() => setActiveSessionId(pinnedSession.id)}
            >
              <span className={`status-dot-sm status-${pinnedSession.status}`} aria-hidden="true"></span>
              <span className="easy-session-item-name">💬 {pinnedSession.name}</span>
            </li>
          )}
          {otherSessions.map(session => (
            <li
              key={session.id}
              className={`easy-session-item${session.id === activeSessionId ? ' active' : ''}`}
              onClick={() => setActiveSessionId(session.id)}
            >
              <span className={`status-dot-sm status-${session.status}`} aria-hidden="true"></span>
              <span className="easy-session-item-name">{session.name}</span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="easy-session-detail">
        {!activeSession ? (
          <div className="session-empty-state">
            <p className="session-empty-msg">Loading your chat session…</p>
          </div>
        ) : (
          <div className="session-detail">
            <div className="session-detail-header">
              <div className="session-info">
                <h3>{activeSession.name}</h3>
                <span className={`session-status-badge status-${activeSession.status}`}>{activeSession.status}</span>
              </div>
              <div className="session-controls">
                {!isRunning && (
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => apiFetch(`/api/sessions/${activeSession.id}/start`, { method: 'POST' })}
                  >
                    Start
                  </button>
                )}
                {isRunning && !activeSession.isPermanent && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => apiFetch(`/api/sessions/${activeSession.id}/stop`, { method: 'POST' })}
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
            <div className="session-activity">
              <span className={`activity-dot activity-${activity?.type || 'idle'}`}></span>
              <span>{activity?.detail || activity?.type || 'Idle'}</span>
            </div>
            <div className="session-output-wrapper">
              <SessionDetailTabs sessionId={activeSession.id} sessionStatus={activeSession.status} output={output} />
            </div>
            <div className="session-prompt-bar">
              <input
                type="text"
                placeholder={canSendPrompt ? 'Send a message...' : 'This session is not accepting messages right now'}
                aria-label="Chat message"
                disabled={!canSendPrompt}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
              />
              <button className="btn btn-primary btn-sm" disabled={!canSendPrompt} onClick={handleSendChat}>Send</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
