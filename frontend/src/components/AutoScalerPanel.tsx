import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { ModelSelect } from './ModelSelect';
import { useConfirmAction } from '../hooks/useConfirmAction';
import type { AutoScaler } from '../types';

/**
 * Auto-Scaler controls panel — rendered inside the SessionsPanel sidebar only when
 * the user's uiViewMode is 'looper'. Shows a form to create a new Auto-Scaler and
 * a compact list of existing Auto-Scalers with start/stop controls.
 *
 * Props:
 *   selectedId    — currently selected auto-scaler id (controlled by SessionsPanel)
 *   onSelect      — callback when the user clicks a card (passes the auto-scaler id)
 */
export function AutoScalerPanel({
  selectedId,
  onSelect,
}: {
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { autoScalers, setAutoScalers, agents, tabs, fetchAutoScalers } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [selectedTabIds, setSelectedTabIds] = useState<number[]>([]);
  const [model, setModel] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);

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
    if (selectedTabIds.length === 0) {
      setFormError('At least one tab is required');
      return;
    }

    try {
      const res = await apiFetch('/api/autoscalers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agentName,
          tabIds: selectedTabIds,
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
      setShowForm(false);
      setName('');
      setAgentName('');
      setSelectedTabIds([]);
      setModel('');
      setMaxConcurrency(5);
      setIdleTimeoutSeconds(30);
      await fetchAutoScalers();
    } catch (err) {
      setFormError('Network error');
    }
  };

  const handleStart = async (autoScalerId: number) => {
    try {
      await apiFetch(`/api/autoscalers/${autoScalerId}/start`, { method: 'POST' });
    } catch { /* WS update will reflect state */ }
  };

  const handleStop = async (autoScalerId: number) => {
    try {
      await apiFetch(`/api/autoscalers/${autoScalerId}/stop`, { method: 'POST' });
    } catch { /* WS update will reflect state */ }
  };

  const handleDelete = async (autoScalerId: number) => {
    try {
      await apiFetch(`/api/autoscalers/${autoScalerId}`, { method: 'DELETE' });
      setAutoScalers(prev => prev.filter(f => f.id !== autoScalerId));
    } catch { /* ignore */ }
  };

  const handleTabToggle = (tabId: number) => {
    setSelectedTabIds(prev =>
      prev.includes(tabId) ? prev.filter(id => id !== tabId) : [...prev, tabId]
    );
  };

  return (
    <div className="autoscaler-panel" data-testid="autoscaler-panel">
      <div className="autoscaler-panel-header">
        <h4>Auto-Scalers</h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Auto-Scaler'}
        </button>
      </div>
      <p className="autoscaler-panel-tagline">Auto-scaling pool of agent sessions that scales to match the task queue.</p>

      {showForm && (
        <form className="autoscaler-create-form" onSubmit={handleCreate}>
          <div className="form-group">
            <label htmlFor="autoScalerName">Name</label>
            <input
              id="autoScalerName"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Auto-Scaler"
            />
          </div>
          <div className="form-group">
            <label htmlFor="autoScalerAgent">Agent</label>
            <select id="autoScalerAgent" value={agentName} onChange={e => setAgentName(e.target.value)}>
              <option value="">Select agent...</option>
              {agents.map(a => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Tabs</label>
            <div className="autoscaler-tab-checkboxes">
              {tabs.map(t => (
                <label key={t.id} className="autoscaler-tab-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedTabIds.includes(t.id)}
                    onChange={() => handleTabToggle(t.id)}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="autoScalerModel">Model (optional)</label>
            <ModelSelect id="autoScalerModel" value={model} onChange={setModel} placeholder="e.g. claude-sonnet-4-20250514" />
          </div>
          <div className="form-group">
            <label htmlFor="autoScalerMaxConcurrency">Max Concurrency (0 = unlimited)</label>
            <input
              id="autoScalerMaxConcurrency"
              type="number"
              min={0}
              value={maxConcurrency}
              onChange={e => setMaxConcurrency(Number(e.target.value))}
            />
          </div>
          <div className="form-group">
            <label htmlFor="autoScalerIdleTimeout">Idle Timeout (seconds)</label>
            <input
              id="autoScalerIdleTimeout"
              type="number"
              min={0}
              value={idleTimeoutSeconds}
              onChange={e => setIdleTimeoutSeconds(Number(e.target.value))}
            />
          </div>
          {formError && <div className="form-message error">{formError}</div>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm">Create Auto-Scaler</button>
          </div>
        </form>
      )}

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
        {autoScalers.length === 0 && !showForm && (
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

  // Edit form state — initialised from the auto-scaler
  const [editName, setEditName] = useState(autoScaler.name);
  const [editAgentName, setEditAgentName] = useState(autoScaler.agentName);
  const [editTabIds, setEditTabIds] = useState<number[]>(autoScaler.tabIds);
  const [editModel, setEditModel] = useState(autoScaler.model ?? '');
  const [editMaxConcurrency, setEditMaxConcurrency] = useState(autoScaler.maxConcurrency);
  const [editIdleTimeoutSeconds, setEditIdleTimeoutSeconds] = useState(autoScaler.idleTimeoutSeconds);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleTabToggle = (tabId: number) => {
    setEditTabIds(prev =>
      prev.includes(tabId) ? prev.filter(id => id !== tabId) : [...prev, tabId]
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      // Build patch with only changed fields
      const patch: Record<string, unknown> = {};
      if (editName.trim() !== autoScaler.name) patch.name = editName.trim();
      if (editAgentName !== autoScaler.agentName) patch.agentName = editAgentName;
      // Compare tabIds (order-insensitive)
      const sortedEdit = [...editTabIds].sort((a, b) => a - b);
      const sortedOrig = [...autoScaler.tabIds].sort((a, b) => a - b);
      if (JSON.stringify(sortedEdit) !== JSON.stringify(sortedOrig)) patch.tabIds = editTabIds;
      const normalizedModel = editModel.trim() && editModel.trim() !== 'auto' ? editModel.trim() : undefined;
      if (normalizedModel !== autoScaler.model) patch.model = normalizedModel;
      if (editMaxConcurrency !== autoScaler.maxConcurrency) patch.maxConcurrency = editMaxConcurrency;
      if (editIdleTimeoutSeconds !== autoScaler.idleTimeoutSeconds) patch.idleTimeoutSeconds = editIdleTimeoutSeconds;

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
      await fetchAutoScalers();
    } catch {
      setSaveError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (isRunning) return;
    try {
      await apiFetch(`/api/autoscalers/${autoScaler.id}`, { method: 'DELETE' });
      setAutoScalers(prev => prev.filter(f => f.id !== autoScaler.id));
      onClose?.();
    } catch { /* ignore */ }
  };
  const { isPending: deleteConfirmPending, handleClick: handleDeleteClick } = useConfirmAction(handleDelete);

  const tabNames = autoScaler.tabIds
    .map(tid => tabs.find(t => t.id === tid)?.name || `#${tid}`)
    .join(', ') || 'None';

  const displayModel = autoScaler.model ? autoScaler.model : 'auto';
  const displayMax = autoScaler.maxConcurrency === 0 ? '∞' : String(autoScaler.maxConcurrency);
  const displayCreatedAt = new Date(autoScaler.createdAt).toLocaleString();

  return (
    <div className="autoscaler-detail-panel" data-testid="autoscaler-detail-panel">
      <div className="autoscaler-detail-header">
        <div className="autoscaler-detail-title">
          <h3>{autoScaler.name}</h3>
          <span className={`autoscaler-status-badge status-${autoScaler.status}`}>{autoScaler.status}</span>
          {autoScaler.runningSessionCount !== undefined && (
            <span className="autoscaler-detail-running-count">{autoScaler.runningSessionCount} running</span>
          )}
        </div>
        <div className="autoscaler-detail-meta-grid">
          <span className="autoscaler-meta-label">Agent</span><span>{autoScaler.agentName}</span>
          <span className="autoscaler-meta-label">Tabs</span><span>{tabNames}</span>
          <span className="autoscaler-meta-label">Model</span><span>{displayModel}</span>
          <span className="autoscaler-meta-label">Max Concurrency</span><span>{displayMax}</span>
          <span className="autoscaler-meta-label">Idle Timeout</span><span>{autoScaler.idleTimeoutSeconds}s</span>
          <span className="autoscaler-meta-label">Created</span><span>{displayCreatedAt}</span>
        </div>
      </div>

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
            {agents.map(a => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Tabs</label>
          <div className="autoscaler-tab-checkboxes">
            {tabs.map(t => (
              <label key={t.id} className="autoscaler-tab-checkbox">
                <input
                  type="checkbox"
                  checked={editTabIds.includes(t.id)}
                  disabled={isRunning}
                  onChange={() => handleTabToggle(t.id)}
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="editAutoScalerModel">Model</label>
          <ModelSelect id="editAutoScalerModel" value={editModel} onChange={setEditModel} />
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
            disabled={isRunning || saving}
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
      </form>
    </div>
  );
}
