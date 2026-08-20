import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { SessionModal } from './SessionModal';
import { SessionDetailTabs } from './SessionDetailTabs';
import { apiFetch } from '../utils/api';
import { formatCreditsWithEur } from '../utils/format';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { useMobileBreakpoint } from '../hooks/useMobileBreakpoint';
import type { Session, OutputEntry, SessionActivity } from '../types';

export function SessionsPanel() {
  const { sessions, setSessions, currentTabId, activeSessionId, setActiveSessionId, tabs, pendingOps, errors, setActiveView, setHighlightedTaskId } = useApp();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const dragIdRef = useRef<number | null>(null);
  const isMobile = useMobileBreakpoint();
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const scrollTopRef = useRef<number>(0);

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
    (async () => {
      try {
        const res = await apiFetch(`/api/sessions/${activeSessionId}/output`);
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

  // Auto-scroll is managed internally by SessionDetailTabs and SessionTimeline

  const handleStart = async () => {
    if (!activeSessionId) return;
    await apiFetch(`/api/sessions/${activeSessionId}/start`, { method: 'POST' });
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    await apiFetch(`/api/sessions/${activeSessionId}/stop`, { method: 'POST' });
  };

  const handleDelete = async () => {
    if (!activeSessionId) return;
    await apiFetch(`/api/sessions/${activeSessionId}`, { method: 'DELETE' });
    setSessions(prev => prev.filter(s => s.id !== activeSessionId));
    setActiveSessionId(null);
  };

  const { isPending: deleteConfirmPending, handleClick: handleDeleteClick } = useConfirmAction(handleDelete);

  const handleEdit = () => {
    if (!activeSession) return;
    if (activeSession.status === 'running') {
      alert('Stop the session to edit its settings.');
      return;
    }
    setEditingSession(activeSession);
  };

  const handleSendPrompt = async (text: string) => {
    if (!text.trim() || !activeSessionId) return;
    await apiFetch(`/api/sessions/${activeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  };

  // Session pin/unpin via right-click context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: Session } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, session: Session) => {
    if (session.isPermanent) return; // permanent sessions cannot be unpinned
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  };

  const handlePinToggle = async () => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    const newPinned = !session.pinned;
    setContextMenu(null);

    pendingOps.current.add('sessions-reordered');
    setSessions(prev => prev.map(s => s.id === session.id ? { ...s, pinned: newPinned } : s));

    try {
      await apiFetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: newPinned }),
      });
    } catch {
      pendingOps.current.delete('sessions-reordered');
    }
  };

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  // Container-level drop handler for pinned section (enables pinning by dropping into empty area)
  const handlePinnedContainerDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = dragIdRef.current;
    if (!draggedId) return;
    const draggedSession = sessions.find(s => s.id === draggedId);
    if (!draggedSession || draggedSession.pinned) return;

    pendingOps.current.add('sessions-reordered');
    setSessions(prev => prev.map(s => s.id === draggedId ? { ...s, pinned: true } : s));

    try {
      await apiFetch(`/api/sessions/${draggedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      });
    } catch {
      pendingOps.current.delete('sessions-reordered');
    }
  };

  // Session drag-and-drop reordering
  const handleDragStart = (e: React.DragEvent, session: Session) => {
    dragIdRef.current = session.id;
    e.dataTransfer.setData('application/x-session-id', String(session.id));
    e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('session-dragging');
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('session-dragging');
    dragIdRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetSession: Session) => {
    e.preventDefault();
    const draggedId = dragIdRef.current;
    if (!draggedId || draggedId === targetSession.id) return;

    const draggedSession = sessions.find(s => s.id === draggedId);
    if (!draggedSession) return;

    // Handle pin/unpin if dragging between sections
    const targetPinned = targetSession.pinned ?? false;
    const draggedPinned = draggedSession.pinned ?? false;

    if (draggedPinned !== targetPinned) {
      // Pin/unpin the dragged session to match target section
      pendingOps.current.add('sessions-reordered');
      try {
        await apiFetch(`/api/sessions/${draggedId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: targetPinned }),
        });
      } catch { /* ignore */ }
    }

    // Reorder within same section
    const sectionSessions = sessions
      .filter(s => (s.pinned ?? false) === targetPinned && s.id !== draggedId);
    const targetIdx = sectionSessions.findIndex(s => s.id === targetSession.id);
    sectionSessions.splice(targetIdx, 0, { ...draggedSession, pinned: targetPinned });

    const orderedIds = sectionSessions.map(s => s.id);
    pendingOps.current.add('sessions-reordered');

    // Update local state
    setSessions(prev => {
      const updated = [...prev];
      orderedIds.forEach((id, i) => {
        const idx = updated.findIndex(s => s.id === id);
        if (idx !== -1) {
          updated[idx] = { ...updated[idx], sortOrder: i, pinned: targetPinned || updated[idx].pinned };
        }
      });
      // Update the dragged session's pinned state
      const dragIdx = updated.findIndex(s => s.id === draggedId);
      if (dragIdx !== -1) {
        updated[dragIdx] = { ...updated[dragIdx], pinned: targetPinned };
      }
      return updated;
    });

    try {
      await apiFetch('/api/sessions/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: orderedIds }),
      });
    } catch (e) {
      console.error('Failed to reorder sessions:', e);
      pendingOps.current.delete('sessions-reordered');
    }
  };

  // Compute which sessions have errors (matched by session name)
  const sessionNamesWithErrors = new Set(
    errors.map(e => e.sessionName)
  );

  const isRunning = activeSession?.status === 'running';
  const isInteractive = activeSession?.interactive !== false;
  const isLoop = activeSession?.loop === true;
  const canSendPrompt = isRunning && isInteractive && !isLoop;

  // Session tabs display
  const sessionTabNames = activeSession?.tabIds
    ?.map(tid => tabs.find(b => b.id === tid)?.name || `#${tid}`)
    .join(', ') || 'None';

  // Mobile drill-down: when a session is tapped on mobile, transition to detail view
  const listPanelRef = useRef<HTMLElement>(null);
  const handleMobileSessionClick = (sessionId: number) => {
    setActiveSessionId(sessionId);
    if (isMobile) {
      // Save scroll position before navigating away
      if (listPanelRef.current) {
        scrollTopRef.current = listPanelRef.current.scrollTop;
      }
      setMobileShowDetail(true);
    }
  };

  const handleMobileBack = () => {
    setMobileShowDetail(false);
    // Restore scroll position after returning to list
    requestAnimationFrame(() => {
      if (listPanelRef.current) {
        listPanelRef.current.scrollTop = scrollTopRef.current;
      }
    });
  };

  // Reset mobile detail state when viewport becomes desktop
  useEffect(() => {
    if (!isMobile) {
      setMobileShowDetail(false);
    }
  }, [isMobile]);

  // Reset mobile detail state when tab changes
  useEffect(() => {
    if (isMobile) {
      setMobileShowDetail(false);
    }
  }, [currentTabId]);

  const listHidden = isMobile && mobileShowDetail;
  const detailHidden = isMobile && !mobileShowDetail;

  return (
    <section id="panel-sessions" role="tabpanel" aria-labelledby="tab-sessions">
      <div className="sessions-layout">
        <aside className={`session-list-panel${listHidden ? ' mobile-hidden' : ''}`} ref={listPanelRef}>
          <div className="toolbar" role="toolbar" aria-label="Session actions">
            <button id="newSessionBtn" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Session</button>
          </div>
          <ul
            className="session-list-pinned"
            id="sessionListPinned"
            aria-label="Pinned sessions"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={handlePinnedContainerDrop}
            style={{ minHeight: '24px' }}
          >
            {sortedSessions.filter(s => s.pinned).map(session => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                hasErrors={sessionNamesWithErrors.has(session.name)}
                onClick={() => handleMobileSessionClick(session.id)}
                onDragStart={(e) => handleDragStart(e, session)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, session)}
                onContextMenu={(e) => handleContextMenu(e, session)}
              />
            ))}
          </ul>
          <ul className="session-list" id="sessionList" aria-label="Agent sessions">
            {sortedSessions.filter(s => !s.pinned).map(session => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                hasErrors={sessionNamesWithErrors.has(session.name)}
                onClick={() => handleMobileSessionClick(session.id)}
                onDragStart={(e) => handleDragStart(e, session)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, session)}
                onContextMenu={(e) => handleContextMenu(e, session)}
              />
            ))}
            {sortedSessions.length === 0 && (
              <li className="session-empty-hint">No sessions for this tab. Create one with + New Session.</li>
            )}
          </ul>
        </aside>
        <div className={`session-detail-panel${detailHidden ? ' mobile-hidden' : ''}`} id="sessionDetailPanel">
          {!activeSession ? (
            <div className="session-empty-state">
              {isMobile && mobileShowDetail && (
                <button className="mobile-back-btn" onClick={handleMobileBack} aria-label="Back to session list">
                  ←
                </button>
              )}
              <p className="session-empty-msg">No sessions available for this tab.</p>
            </div>
          ) : (
            <div className="session-detail" id="sessionDetail">
              <div className="session-detail-header">
                <div className="session-info">
                  {isMobile && (
                    <button className="mobile-back-btn" onClick={handleMobileBack} aria-label="Back to session list">
                      ←
                    </button>
                  )}
                  <h3 id="sessionDetailName">{activeSession.name}</h3>
                  <span className="session-agent-badge">{activeSession.agent || 'Interactive'}</span>
                  <span className={`session-status-badge status-${activeSession.status}`}>{activeSession.status}</span>
                </div>
                <div className="session-controls">
                  <button className="btn btn-success btn-sm" disabled={isRunning} onClick={handleStart}>Start</button>
                  <button className="btn btn-danger btn-sm" disabled={!isRunning} onClick={handleStop}>Stop</button>
                  <button className="btn btn-secondary btn-sm" id="sessionEditBtn" disabled={isRunning} title={isRunning ? 'Stop the session to edit its settings' : 'Edit session settings'} onClick={handleEdit}>Edit</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setOutput([])}>Clear</button>
                  <button className={`btn btn-secondary btn-sm${deleteConfirmPending ? ' btn-confirm-pending' : ''}`} disabled={!!activeSession.isPermanent} onClick={handleDeleteClick}>{deleteConfirmPending ? 'Confirm?' : 'Delete'}</button>
                </div>
              </div>
              {((activeSession.turnCount ?? 0) > 0 || (activeSession.totalCreditsUsed ?? 0) > 0) && (
                <div className="session-detail-meta" data-testid="session-detail-meta">
                  {(activeSession.turnCount ?? 0) > 0 && (
                    <span className="session-meta-turns">🔄 {activeSession.turnCount} turn{activeSession.turnCount !== 1 ? 's' : ''}</span>
                  )}
                  {(activeSession.totalCreditsUsed ?? 0) > 0 && (
                    <span className="session-meta-credits">
                      💰 {formatCreditsWithEur(activeSession.totalCreditsUsed!).creditsStr} credits (€{formatCreditsWithEur(activeSession.totalCreditsUsed!).eurStr})
                    </span>
                  )}
                  {activeSession.currentTaskId && activeSession.currentTaskTitle && (
                    <span
                      className="session-meta-task"
                      data-testid="session-current-task-link"
                      role="button"
                      tabIndex={0}
                      onClick={() => { setHighlightedTaskId(activeSession.currentTaskId!); setActiveView('boards'); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHighlightedTaskId(activeSession.currentTaskId!); setActiveView('boards'); } }}
                    >
                      📋 <strong>#{activeSession.currentTaskId}</strong> {activeSession.currentTaskTitle}
                    </span>
                  )}
                </div>
              )}
              <div className="session-tabs-bar">
                <span className="session-tabs-label">Tabs:</span>
                <span className="session-tabs-list">{sessionTabNames}</span>
              </div>
              <div className="session-activity" id="sessionActivityBar">
                <span className={`activity-dot activity-${activity?.type || 'idle'}`}></span>
                <span>{activity?.detail || activity?.type || 'Idle'}</span>
              </div>
              <div className="session-output-wrapper">
                <SessionDetailTabs
                  sessionId={activeSession.id}
                  sessionStatus={activeSession.status}
                  output={output}
                />
              </div>
              <SessionPromptBar canSend={canSendPrompt} isLoop={isLoop} isInteractive={isInteractive} session={activeSession} onSend={handleSendPrompt} />
            </div>
          )}
        </div>
      </div>

      {(showCreateModal || editingSession) && (
        <SessionModal
          session={editingSession}
          onClose={() => { setShowCreateModal(false); setEditingSession(null); }}
        />
      )}

      {contextMenu && (
        <div
          className="session-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y, position: 'fixed', zIndex: 9999 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="session-context-item" onClick={handlePinToggle}>
            {contextMenu.session.pinned ? '📌 Unpin' : '📌 Pin to top'}
          </button>
        </div>
      )}
    </section>
  );
}

function SessionListItem({ session, active, hasErrors, onClick, onDragStart, onDragEnd, onDragOver, onDrop, onContextMenu }: {
  session: Session;
  active: boolean;
  hasErrors: boolean;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const statusClass = `status-dot-sm status-${session.status}`;
  const activityDetail = session.currentActivity?.detail || session.currentActivity?.type || '';
  const credits = session.totalCreditsUsed ?? 0;

  return (
    <li
      className={`session-item${active ? ' active' : ''}${session.pinned ? ' session-item-pinned' : ''}`}
      data-session-id={session.id}
      draggable
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className={statusClass} aria-hidden="true"></span>
      <div className="session-item-info">
        <span className="session-item-name">
          {session.pinned && <span className="session-item-pin" title="Pinned">📌</span>}
          {session.name}
          {hasErrors && <span className="session-item-error-dot" data-testid={`session-error-indicator-${session.id}`} title="Has errors">●</span>}
        </span>
        <span className="session-item-agent">{session.agent || <em>Interactive</em>}</span>
        {session.status === 'running' && activityDetail && (
          <span className="session-item-activity">{activityDetail}</span>
        )}
        {session.status === 'running' && session.currentTaskId && session.currentTaskTitle && (
          <span className="session-item-task">
            <span className="session-item-task-id">#{session.currentTaskId}</span>{' '}
            {session.currentTaskTitle.length > 30 ? session.currentTaskTitle.slice(0, 30) + '…' : session.currentTaskTitle}
          </span>
        )}
        {session.status === 'running' && credits > 0 && (
          <span className="session-item-usage">
            💰 {formatCreditsWithEur(credits).creditsStr} credits (€{formatCreditsWithEur(credits).eurStr})
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
