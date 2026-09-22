import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { ModelSelect } from './ModelSelect';
import { useConfirmAction } from '../hooks/useConfirmAction';
import type { AutoScaler, Session, TurnRecord, OutputEntry } from '../types';

/**
 * Auto-Scaler controls panel — rendered inside the SessionsPanel sidebar only when
 * the user's uiViewMode is 'looper'. Shows a compact list of existing Auto-Scalers
 * with start/stop controls and a button to open the create form in the detail panel.
 *
 * Props:
 *   selectedId      — currently selected auto-scaler id (controlled by SessionsPanel)
 *   onSelect        — callback when the user clicks a card (passes the auto-scaler id)
 *   onRequestCreate — callback when the user clicks "+ New Auto-Scaler"
 */
export function AutoScalerPanel({
  selectedId,
  onSelect,
  onRequestCreate,
}: {
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRequestCreate: () => void;
}) {
  const { autoScalers } = useApp();

  const handleStart = async (autoScalerId: number) => {
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScalerId}/start`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('[AutoScaler] Start failed:', data.error || res.statusText);
      }
    } catch (err) {
      console.error('[AutoScaler] Start error:', err);
    }
  };

  const handleStop = async (autoScalerId: number) => {
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScalerId}/stop`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('[AutoScaler] Stop failed:', data.error || res.statusText);
      }
    } catch (err) {
      console.error('[AutoScaler] Stop error:', err);
    }
  };

  return (
    <div className="autoscaler-panel" data-testid="autoscaler-panel">
      <div className="autoscaler-panel-header">
        <h4>Auto-Scalers</h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={onRequestCreate}
        >
          + New Auto-Scaler
        </button>
      </div>
      <p className="autoscaler-panel-tagline">Auto-scaling pool of agent sessions that scales to match the task queue.</p>

      <ul className="autoscaler-list">
        {autoScalers.map(autoScaler => (
          <AutoScalerCard
            key={autoScaler.id}
            autoScaler={autoScaler}
            selected={autoScaler.id === selectedId}
            onSelect={() => onSelect(autoScaler.id)}
            onStart={() => handleStart(autoScaler.id)}
            onStop={() => handleStop(autoScaler.id)}
          />
        ))}
        {autoScalers.length === 0 && (
          <li className="autoscaler-empty-hint">No auto-scalers yet. Create one to auto-scale sessions.</li>
        )}
      </ul>
    </div>
  );
}

/**
 * Compact auto-scaler card — shows only name, a running indicator dot, and
 * Start/Stop buttons. Agent/max/count/Delete live in the detail view.
 */
function AutoScalerCard({
  autoScaler,
  selected,
  onSelect,
  onStart,
  onStop,
}: {
  autoScaler: AutoScaler;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const isRunning = autoScaler.status === 'running';

  return (
    <li
      className={`autoscaler-card${isRunning ? ' autoscaler-running' : ''}${selected ? ' autoscaler-card--selected' : ''}`}
      data-autoscaler-id={autoScaler.id}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
    >
      <div className="autoscaler-card-compact">
        <span className={`autoscaler-status-dot${isRunning ? ' autoscaler-status-dot--running' : ''}`} aria-hidden="true" />
        <span className="autoscaler-card-name">{autoScaler.name}</span>
        <div className="autoscaler-card-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-success btn-sm"
            disabled={isRunning}
            onClick={onStart}
            aria-label="Start"
          >
            Start
          </button>
          <button
            className="btn btn-danger btn-sm"
            disabled={!isRunning}
            onClick={onStop}
            aria-label="Stop"
          >
            Stop
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * Full detail + edit view for a selected auto-scaler. Rendered in the
 * right-hand session-detail-panel by SessionsPanel.
 */
export function AutoScalerDetailView({
  autoScaler,
  onClose,
}: {
  autoScaler: AutoScaler;
  onClose?: () => void;
}) {
  const { tabs, agents, setAutoScalers, fetchAutoScalers } = useApp();
  const isRunning = autoScaler.status === 'running';

  // View vs. edit mode toggle
  const [editMode, setEditMode] = useState(false);

  // Edit form state — initialised from the auto-scaler
  const [editName, setEditName] = useState(autoScaler.name);
  const [editAgentName, setEditAgentName] = useState(autoScaler.agentName);
  const [editTabId, setEditTabId] = useState<number | null>(autoScaler.tabIds[0] ?? null);
  const [editModel, setEditModel] = useState(autoScaler.model ?? '');
  const [editMaxConcurrency, setEditMaxConcurrency] = useState(autoScaler.maxConcurrency);
  const [editIdleTimeoutSeconds, setEditIdleTimeoutSeconds] = useState(autoScaler.idleTimeoutSeconds);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [startStopError, setStartStopError] = useState<string | null>(null);

  // Child sessions state
  const [childSessions, setChildSessions] = useState<Session[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<number | null>(null);
  const [sessionTurns, setSessionTurns] = useState<Record<number, TurnRecord[]>>({});
  const [sessionOutput, setSessionOutput] = useState<Record<number, OutputEntry[]>>({});
  const [selectedTurn, setSelectedTurn] = useState<Record<number, number | null>>({});

  // Re-sync form state when the autoScaler prop changes (e.g. via WS autoscaler-updated event).
  // This ensures the edit form shows up-to-date values even if a WS event arrives while the
  // detail view is open (the component is not remounted because the key doesn't change).
  // NOTE: Each effect only fires when the corresponding primitive field value actually changes.
  // WS events from Start/Stop (which flip `status` but leave name/agentName/model/etc unchanged)
  // do NOT overwrite in-progress edits, because React bails out of effects whose dependency
  // values are primitive-equal. The overwrite only occurs when another actor (e.g. a second
  // admin) changes that specific field server-side and a WS event carries the new value through.
  // In that case, losing unsaved edits is the accepted tradeoff: WS updates keep the view
  // consistent with the actual server state.
  useEffect(() => { setEditName(autoScaler.name); }, [autoScaler.name]);
  useEffect(() => { setEditAgentName(autoScaler.agentName); }, [autoScaler.agentName]);
  useEffect(() => { setEditTabId(autoScaler.tabIds[0] ?? null); }, [autoScaler.tabIds[0]]);
  useEffect(() => { setEditModel(autoScaler.model ?? ''); }, [autoScaler.model]);
  useEffect(() => { setEditMaxConcurrency(autoScaler.maxConcurrency); }, [autoScaler.maxConcurrency]);
  useEffect(() => { setEditIdleTimeoutSeconds(autoScaler.idleTimeoutSeconds); }, [autoScaler.idleTimeoutSeconds]);

  // Fetch child sessions on mount and when the autoscaler id changes
  useEffect(() => {
    let cancelled = false;
    async function fetchChildSessions() {
      try {
        const res = await apiFetch(`/api/autoscalers/${autoScaler.id}/sessions`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setChildSessions(Array.isArray(data) ? data : []);
        }
      } catch {
        // Silently ignore fetch errors; the section will show the empty hint
      }
    }
    fetchChildSessions();
    return () => { cancelled = true; };
  }, [autoScaler.id]);

  const handleDetailStart = async () => {
    setStartStopError(null);
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScaler.id}/start`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStartStopError(data.error || 'Failed to start');
      }
    } catch {
      setStartStopError('Network error');
    }
  };

  const handleDetailStop = async () => {
    setStartStopError(null);
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScaler.id}/stop`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStartStopError(data.error || 'Failed to stop');
      }
    } catch {
      setStartStopError('Network error');
    }
  };

  const normalizedEditModel = editModel.trim() && editModel.trim() !== 'auto' ? editModel.trim() : null;
  const hasChanges =
    editName.trim() !== autoScaler.name ||
    editAgentName !== autoScaler.agentName ||
    editTabId !== (autoScaler.tabIds[0] ?? null) ||
    normalizedEditModel !== (autoScaler.model ?? null) ||
    editMaxConcurrency !== autoScaler.maxConcurrency ||
    editIdleTimeoutSeconds !== autoScaler.idleTimeoutSeconds;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    if (!editName.trim()) {
      setSaveError('Name is required');
      return;
    }
    if (!editAgentName) {
      setSaveError('Agent is required');
      return;
    }
    if (!editTabId) {
      setSaveError('At least one tab is required');
      return;
    }

    // Build patch with only changed fields (before try/finally so we can return
    // early without ever calling setSaving(true), avoiding a spurious state update)
    const patch: Record<string, unknown> = {};
    if (editName.trim() !== autoScaler.name) patch.name = editName.trim();
    if (editAgentName !== autoScaler.agentName) patch.agentName = editAgentName;
    // Compare tabId (single selection)
    if (editTabId !== (autoScaler.tabIds[0] ?? null)) patch.tabIds = [editTabId];
    if (normalizedEditModel !== (autoScaler.model ?? null)) patch.model = normalizedEditModel;
    if (editMaxConcurrency !== autoScaler.maxConcurrency) patch.maxConcurrency = editMaxConcurrency;
    if (editIdleTimeoutSeconds !== autoScaler.idleTimeoutSeconds) patch.idleTimeoutSeconds = editIdleTimeoutSeconds;

    if (Object.keys(patch).length === 0) {
      setEditMode(false);
      return; // nothing changed — setSaving is never called, so no spurious re-render
    }

    setSaving(true);
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScaler.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error || 'Failed to save');
        return;
      }
      setEditMode(false);
      await fetchAutoScalers();
    } catch {
      setSaveError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    // Reset form fields back to current autoScaler values
    setEditName(autoScaler.name);
    setEditAgentName(autoScaler.agentName);
    setEditTabId(autoScaler.tabIds[0] ?? null);
    setEditModel(autoScaler.model ?? '');
    setEditMaxConcurrency(autoScaler.maxConcurrency);
    setEditIdleTimeoutSeconds(autoScaler.idleTimeoutSeconds);
    setSaveError(null);
    setEditMode(false);
  };

  const handleDelete = async () => {
    if (isRunning) return;
    setDeleteError(null);
    try {
      const res = await apiFetch(`/api/autoscalers/${autoScaler.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || 'Failed to delete');
        return;
      }
      setAutoScalers(prev => prev.filter(f => f.id !== autoScaler.id));
      onClose?.();
    } catch {
      setDeleteError('Network error');
    }
  };
  const { isPending: deleteConfirmPending, handleClick: handleDeleteClick } = useConfirmAction(handleDelete);

  const tabNames = autoScaler.tabIds
    .map(tid => tabs.find(t => t.id === tid)?.name || `#${tid}`)
    .join(', ') || 'None';

  const displayModel = autoScaler.model ? autoScaler.model : 'auto';
  const displayMax = autoScaler.maxConcurrency === 0 ? '∞' : String(autoScaler.maxConcurrency);
  const displayCreatedAt = new Date(autoScaler.createdAt).toLocaleString();

  // Expand a child session (accordion): fetch turns + output lazily
  const handleExpandSession = async (sessionId: number) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);

    // Fetch turns if not already loaded
    if (!sessionTurns[sessionId]) {
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/turns`);
        if (res.ok) {
          const turns: TurnRecord[] = await res.json();
          setSessionTurns(prev => ({ ...prev, [sessionId]: turns }));
          // Default-select the most recent turn
          if (turns.length > 0) {
            setSelectedTurn(prev => ({ ...prev, [sessionId]: turns[turns.length - 1].number }));
          }
        }
      } catch {
        // ignore
      }
    }

    // Fetch output if not already loaded
    if (!sessionOutput[sessionId]) {
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/output`);
        if (res.ok) {
          const output: OutputEntry[] = await res.json();
          setSessionOutput(prev => ({ ...prev, [sessionId]: output }));
        }
      } catch {
        // ignore
      }
    }
  };

  // Slice output to the selected turn's time range
  function getTurnOutput(sessionId: number, turnNumber: number | null): OutputEntry[] {
    if (turnNumber === null) return [];
    const turns = sessionTurns[sessionId] ?? [];
    const turn = turns.find(t => t.number === turnNumber);
    if (!turn) return [];
    const allOutput = sessionOutput[sessionId] ?? [];
    const startMs = new Date(turn.startedAt).getTime();
    const endMs = turn.endedAt ? new Date(turn.endedAt).getTime() : Infinity;
    return allOutput.filter(entry => {
      if (!entry.timestamp) return false;
      const ts = new Date(entry.timestamp).getTime();
      return ts >= startMs && ts <= endMs;
    });
  }

  function formatDurationMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  return (
    <div className="autoscaler-detail-panel" data-testid="autoscaler-detail-panel">
      <div className="autoscaler-detail-header">
        <div className="autoscaler-detail-title">
          <h3>{autoScaler.name}</h3>
          <span className={`autoscaler-status-badge status-${autoScaler.status}`}>{autoScaler.status}</span>
          {autoScaler.runningSessionCount !== undefined && (
            <span className="autoscaler-detail-running-count">{autoScaler.runningSessionCount} running</span>
          )}
          <button
            className="btn btn-success btn-sm"
            disabled={isRunning}
            onClick={handleDetailStart}
            aria-label="Start"
          >
            Start
          </button>
          <button
            className="btn btn-danger btn-sm"
            disabled={!isRunning}
            onClick={handleDetailStop}
            aria-label="Stop"
          >
            Stop
          </button>
          {editMode ? (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleCancelEdit}
              aria-label="Cancel edit"
            >
              Cancel
            </button>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              disabled={isRunning}
              onClick={() => setEditMode(true)}
              aria-label="Edit"
            >
              Edit
            </button>
          )}
        </div>
        {startStopError && <div className="form-message error">{startStopError}</div>}

        {/* View mode: read-only meta grid */}
        {!editMode && (
          <div className="autoscaler-detail-meta-grid">
            <span className="autoscaler-meta-label">Agent</span><span>{autoScaler.agentName}</span>
            <span className="autoscaler-meta-label">Tabs</span><span>{tabNames}</span>
            <span className="autoscaler-meta-label">Model</span><span>{displayModel}</span>
            <span className="autoscaler-meta-label">Max Concurrency</span><span>{displayMax}</span>
            <span className="autoscaler-meta-label">Idle Timeout</span><span>{autoScaler.idleTimeoutSeconds}s</span>
            <span className="autoscaler-meta-label">Created</span><span>{displayCreatedAt}</span>
          </div>
        )}
      </div>

      {/* Edit mode: show the form */}
      {editMode && (
        <>
          {isRunning && (
            <div className="autoscaler-edit-disabled-hint">
              Stop this auto-scaler first to edit its settings.
            </div>
          )}

          <form className="autoscaler-edit-form" onSubmit={handleSave}>
            <h4>Edit</h4>
            <div className="form-group">
              <label htmlFor="editAutoScalerName">Name</label>
              <input
                id="editAutoScalerName"
                type="text"
                name="name"
                value={editName}
                disabled={isRunning}
                onChange={e => setEditName(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="editAutoScalerAgent">Agent</label>
              <select
                id="editAutoScalerAgent"
                value={editAgentName}
                disabled={isRunning}
                onChange={e => setEditAgentName(e.target.value)}
              >
                <option value="">Select agent...</option>
                {agents.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="editAutoScalerTab">Tabs</label>
              <select
                id="editAutoScalerTab"
                value={editTabId ?? ''}
                disabled={isRunning}
                onChange={e => setEditTabId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select tab...</option>
                {tabs.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="editAutoScalerModel">Model</label>
              <ModelSelect id="editAutoScalerModel" value={editModel} onChange={setEditModel} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label htmlFor="editAutoScalerMaxConcurrency">Max Concurrency (0 = unlimited)</label>
              <input
                id="editAutoScalerMaxConcurrency"
                type="number"
                min={0}
                value={editMaxConcurrency}
                disabled={isRunning}
                onChange={e => setEditMaxConcurrency(Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="editAutoScalerIdleTimeout">Idle Timeout (seconds)</label>
              <input
                id="editAutoScalerIdleTimeout"
                type="number"
                min={0}
                value={editIdleTimeoutSeconds}
                disabled={isRunning}
                onChange={e => setEditIdleTimeoutSeconds(Number(e.target.value))}
              />
            </div>
            {saveError && <div className="form-message error">{saveError}</div>}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={isRunning || saving || !hasChanges}
              >
                Save
              </button>
              <button
                type="button"
                className={`btn btn-secondary btn-sm${deleteConfirmPending ? ' btn-confirm-pending' : ''}`}
                disabled={isRunning}
                onClick={handleDeleteClick}
              >
                {deleteConfirmPending ? 'Confirm?' : 'Delete'}
              </button>
            </div>
            {deleteError && <div className="form-message error">{deleteError}</div>}
          </form>
        </>
      )}

      {/* Child sessions section */}
      <div className="autoscaler-sessions-section">
        <h4 className="autoscaler-sessions-heading">Sessions</h4>
        {childSessions.length === 0 ? (
          <p className="autoscaler-sessions-empty">No sessions spawned yet.</p>
        ) : (
          <ul className="autoscaler-sessions-list">
            {childSessions.map(session => {
              const isExpanded = expandedSessionId === session.id;
              const sessionIsRunning = session.status === 'running';
              const turns = sessionTurns[session.id] ?? [];
              const selTurn = selectedTurn[session.id] ?? null;
              const turnOutput = getTurnOutput(session.id, selTurn);

              return (
                <li key={session.id} className={`autoscaler-session-row${isExpanded ? ' autoscaler-session-row--expanded' : ''}`}>
                  <button
                    className="autoscaler-session-row-header"
                    onClick={() => handleExpandSession(session.id)}
                    aria-expanded={isExpanded}
                  >
                    <span className={`autoscaler-status-dot${sessionIsRunning ? ' autoscaler-status-dot--running' : ''}`} aria-hidden="true" />
                    <span className="autoscaler-session-name">{session.name}</span>
                    <span className={`autoscaler-session-badge${sessionIsRunning ? ' badge-running' : ' badge-stopped'}`}>
                      {sessionIsRunning ? 'running' : 'stopped'}
                    </span>
                    <span className="autoscaler-session-chevron" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                  </button>

                  {isExpanded && (
                    <div className="autoscaler-session-turn-browser">
                      <div className="autoscaler-turn-list">
                        {turns.length === 0 ? (
                          <p className="autoscaler-turns-empty">No turns yet.</p>
                        ) : (
                          <ul>
                            {turns.map(turn => (
                              <li
                                key={turn.number}
                                className={`autoscaler-turn-item${selTurn === turn.number ? ' autoscaler-turn-item--selected' : ''}`}
                                onClick={() => setSelectedTurn(prev => ({ ...prev, [session.id]: turn.number }))}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTurn(prev => ({ ...prev, [session.id]: turn.number })); } }}
                              >
                                <span className="autoscaler-turn-number">#{turn.number}</span>
                                <span className="autoscaler-turn-task">{turn.taskTitle ?? '—'}</span>
                                <span className="autoscaler-turn-verdict">{turn.verdict ?? '—'}</span>
                                <span className="autoscaler-turn-duration">{formatDurationMs(turn.durationMs)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="autoscaler-turn-output">
                        {selTurn === null ? (
                          <p className="autoscaler-turn-output-hint">Select a turn to see its output.</p>
                        ) : turnOutput.length === 0 ? (
                          <p className="autoscaler-turn-output-hint">No output for this turn.</p>
                        ) : (
                          <div className="session-output" role="log" aria-label="Turn output">
                            <pre className="output-pre">
                              {turnOutput.map((entry, i) => {
                                const ts = entry.timestamp ? `[${new Date(entry.timestamp).toLocaleTimeString()}] ` : '';
                                return (
                                  <span key={i} className={`output-line output-${entry.stream}`}>
                                    {ts}{entry.text}{'\n'}
                                  </span>
                                );
                              })}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Create form for a new auto-scaler, rendered in the right-hand detail panel.
 * The tab is read-only, derived from the currently active tab in the app context.
 * On success, calls onCreated(newId); on cancel, calls onClose().
 */
export function AutoScalerCreateView({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { agents, tabs, currentTabId, fetchAutoScalers } = useApp();
  const [name, setName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [model, setModel] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const currentTab = currentTabId !== null ? tabs.find(t => t.id === currentTabId) : undefined;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!agentName) {
      setFormError('Agent is required');
      return;
    }
    if (!currentTabId) {
      setFormError('Select a tab before creating an auto-scaler');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/autoscalers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agentName,
          tabIds: [currentTabId],
          model: (() => {
            const trimmed = model.trim();
            return trimmed && trimmed !== 'auto' ? trimmed : undefined;
          })(),
          maxConcurrency,
          idleTimeoutSeconds,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error || 'Failed to create auto-scaler');
        return;
      }
      const newAutoScaler = await res.json();
      await fetchAutoScalers();
      onCreated(newAutoScaler.id);
    } catch {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="autoscaler-detail-panel" data-testid="autoscaler-create-view">
      <div className="autoscaler-detail-header">
        <div className="autoscaler-detail-title">
          <h3>New Auto-Scaler</h3>
        </div>
      </div>
      <form className="autoscaler-edit-form" onSubmit={handleCreate}>
        <div className="form-group">
          <label htmlFor="createAutoScalerName">Name</label>
          <input
            id="createAutoScalerName"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Auto-Scaler"
          />
        </div>
        <div className="form-group">
          <label htmlFor="createAutoScalerAgent">Agent</label>
          <select id="createAutoScalerAgent" value={agentName} onChange={e => setAgentName(e.target.value)}>
            <option value="">Select agent...</option>
            {agents.map(a => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Tab</label>
          <div className="autoscaler-create-tab-display">
            {currentTab ? currentTab.name : <span className="form-message error" style={{ display: 'inline' }}>Select a tab before creating an auto-scaler</span>}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="createAutoScalerModel">Model (optional)</label>
          <ModelSelect id="createAutoScalerModel" value={model} onChange={setModel} placeholder="e.g. claude-sonnet-4-20250514" />
        </div>
        <div className="form-group">
          <label htmlFor="createAutoScalerMaxConcurrency">Max Concurrency (0 = unlimited)</label>
          <input
            id="createAutoScalerMaxConcurrency"
            type="number"
            min={0}
            value={maxConcurrency}
            onChange={e => setMaxConcurrency(Number(e.target.value))}
          />
        </div>
        <div className="form-group">
          <label htmlFor="createAutoScalerIdleTimeout">Keep-alive / idle timeout (seconds)</label>
          <input
            id="createAutoScalerIdleTimeout"
            type="number"
            min={0}
            value={idleTimeoutSeconds}
            onChange={e => setIdleTimeoutSeconds(Number(e.target.value))}
          />
        </div>
        {formError && <div className="form-message error">{formError}</div>}
        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={submitting || !currentTabId}
          >
            Create Auto-Scaler
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}