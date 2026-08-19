import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { SessionModal } from './SessionModal';
import type { Session, OutputEntry, SessionActivity } from '../types';

export function SessionsPanel() {
  const { sessions, setSessions, currentTabId, activeSessionId, setActiveSessionId, tabs } = useApp();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [showSettingsEditor, setShowSettingsEditor] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Filter sessions for current tab
  const visibleSessions = currentTabId
    ? sessions.filter(s => !s.agent || (s.tabIds && s.tabIds.includes(Number(currentTabId))))
    : sessions;

  const sortedSessions = [...visibleSessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });

  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Auto-select first session
  useEffect(() => {
    if (!activeSessionId && sortedSessions.length > 0) {
      setActiveSessionId(sortedSessions[0].id);
    }
  }, [sortedSessions.length, activeSessionId, setActiveSessionId]);

  // Load session output when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setOutput([]);
      return;
    }
    setAutoScroll(true);
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${activeSessionId}/output`);
        if (!res.ok) return;
        const data: OutputEntry[] = await res.json();
        setOutput(data);
      } catch { /* ignore */ }
    })();
  }, [activeSessionId]);

  // Listen for WS session output
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

  // Listen for WS session activity
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

  // Auto-scroll output
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      const container = outputRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [output, autoScroll]);

  const handleOutputScroll = () => {
    if (!outputRef.current) return;
    const el = outputRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  const handleStart = async () => {
    if (!activeSessionId) return;
    await fetch(`/api/sessions/${activeSessionId}/start`, { method: 'POST' });
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    await fetch(`/api/sessions/${activeSessionId}/stop`, { method: 'POST' });
  };

  const handleDelete = async () => {
    if (!activeSessionId) return;
    await fetch(`/api/sessions/${activeSessionId}`, { method: 'DELETE' });
    setSessions(prev => prev.filter(s => s.id !== activeSessionId));
    setActiveSessionId(null);
  };

  const handleSendPrompt = async (text: string) => {
    if (!text.trim() || !activeSessionId) return;
    await fetch(`/api/sessions/${activeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  };

  const isRunning = activeSession?.status === 'running';
  const isInteractive = activeSession?.interactive !== false;
  const isLoop = activeSession?.loop === true;
  const canSendPrompt = isRunning && isInteractive && !isLoop;

  // Session tabs display
  const sessionTabNames = activeSession?.tabIds
    ?.map(tid => tabs.find(b => b.id === tid)?.name || `#${tid}`)
    .join(', ') || 'None';

  return (
    <section id="panel-sessions" role="tabpanel" aria-labelledby="tab-sessions">
      <div className="sessions-layout">
        <aside className="session-list-panel">
          <div className="toolbar" role="toolbar" aria-label="Session actions">
            <button id="newSessionBtn" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Session</button>
          </div>
          <ul className="session-list-pinned" id="sessionListPinned" aria-label="Pinned sessions">
            {sortedSessions.filter(s => s.pinned).map(session => (
              <SessionListItem key={session.id} session={session} active={session.id === activeSessionId} onClick={() => setActiveSessionId(session.id)} />
            ))}
          </ul>
          <ul className="session-list" id="sessionList" aria-label="Agent sessions">
            {sortedSessions.filter(s => !s.pinned).map(session => (
              <SessionListItem key={session.id} session={session} active={session.id === activeSessionId} onClick={() => setActiveSessionId(session.id)} />
            ))}
            {sortedSessions.length === 0 && (
              <li className="session-empty-hint">No sessions for this tab. Create one with + New Session.</li>
            )}
          </ul>
        </aside>
        <div className="session-detail-panel" id="sessionDetailPanel">
          {!activeSession ? (
            <div className="session-empty-state">
              <p className="session-empty-msg">No sessions available for this tab.</p>
            </div>
          ) : (
            <div className="session-detail" id="sessionDetail">
              <div className="session-detail-header">
                <div className="session-info">
                  <h3 id="sessionDetailName">{activeSession.name}</h3>
                  <span className="session-agent-badge">{activeSession.agent || 'Interactive'}</span>
                  <span className={`session-status-badge status-${activeSession.status}`}>{activeSession.status}</span>
                </div>
                <div className="session-controls">
                  <button className="btn btn-success btn-sm" disabled={isRunning} onClick={handleStart}>Start</button>
                  <button className="btn btn-danger btn-sm" disabled={!isRunning} onClick={handleStop}>Stop</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setOutput([])}>Clear</button>
                  <button className="btn btn-secondary btn-sm" disabled={!!activeSession.isPermanent} onClick={handleDelete}>Delete</button>
                </div>
              </div>
              <div className="session-tabs-bar">
                <span className="session-tabs-label">Tabs:</span>
                <span className="session-tabs-list">{sessionTabNames}</span>
              </div>
              <div className="session-activity" id="sessionActivityBar">
                <span className={`activity-dot activity-${activity?.type || 'idle'}`}></span>
                <span>{activity?.detail || activity?.type || 'Idle'}</span>
              </div>
              <div className="session-output-wrapper">
                <div
                  className="session-output"
                  id="sessionOutput"
                  role="log"
                  aria-live="polite"
                  aria-label="Agent output"
                  tabIndex={0}
                  ref={outputRef}
                  onScroll={handleOutputScroll}
                >
                  <pre className="output-pre" id="outputPre">
                    {output.map((entry, i) => (
                      <span key={i} className={`output-line output-${entry.stream}`}>
                        {entry.timestamp ? `[${new Date(entry.timestamp).toLocaleTimeString()}] ` : ''}{entry.text}{'\n'}
                      </span>
                    ))}
                  </pre>
                </div>
                {!autoScroll && (
                  <button
                    className="scroll-to-bottom-btn"
                    aria-label="Scroll to bottom"
                    title="Scroll to bottom"
                    onClick={() => { setAutoScroll(true); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}
                  >
                    ↓ New output
                  </button>
                )}
              </div>
              <SessionPromptBar canSend={canSendPrompt} isLoop={isLoop} isInteractive={isInteractive} session={activeSession} onSend={handleSendPrompt} />
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <SessionModal onClose={() => setShowCreateModal(false)} />
      )}
    </section>
  );
}

function SessionListItem({ session, active, onClick }: { session: Session; active: boolean; onClick: () => void }) {
  const statusClass = `status-dot-sm status-${session.status}`;
  const activityDetail = session.currentActivity?.detail || session.currentActivity?.type || '';

  return (
    <li
      className={`session-item${active ? ' active' : ''}${session.pinned ? ' session-item-pinned' : ''}`}
      data-session-id={session.id}
      onClick={onClick}
    >
      <span className={statusClass} aria-hidden="true"></span>
      <div className="session-item-info">
        <span className="session-item-name">
          {session.pinned && <span className="session-item-pin" title="Pinned">📌</span>}
          {session.name}
        </span>
        <span className="session-item-agent">{session.agent || <em>Interactive</em>}</span>
        {session.status === 'running' && activityDetail && (
          <span className="session-item-activity">{activityDetail}</span>
        )}
        {session.status === 'running' && (session.totalCreditsUsed ?? 0) > 0 && (
          <span className="session-item-usage">
            💰 {(session.totalCreditsUsed! < 10 ? session.totalCreditsUsed!.toFixed(2) : Math.round(session.totalCreditsUsed!).toString())} credits
          </span>
        )}
      </div>
    </li>
  );
}

function SessionPromptBar({ canSend, isLoop, isInteractive, session, onSend }: {
  canSend: boolean;
  isLoop: boolean;
  isInteractive: boolean;
  session: Session;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');

  let placeholder = 'Send a follow-up prompt...';
  if (isLoop) {
    const runsLabel = session.runs === 0 ? 'endless' : `${session.runs} run(s)`;
    placeholder = `Autonomous — ${runsLabel}, ${session.intervalSeconds}s interval`;
  } else if (!isInteractive) {
    placeholder = 'Non-interactive session';
  }

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div className="session-prompt-bar">
      <input
        type="text"
        id="sessionPromptInput"
        placeholder={placeholder}
        aria-label="Follow-up prompt"
        disabled={!canSend}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
      />
      <button className="btn btn-primary btn-sm" disabled={!canSend} onClick={handleSend}>Send</button>
    </div>
  );
}
