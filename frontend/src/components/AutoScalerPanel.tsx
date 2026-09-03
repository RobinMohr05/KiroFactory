import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { ModelCombobox } from './ModelCombobox';
import type { AutoScaler } from '../types';

/**
 * Auto-Scaler controls panel — rendered inside the SessionsPanel sidebar only when
 * the user's uiViewMode is 'looper'. Shows a form to create a new Auto-Scaler and
 * a list of existing Auto-Scalers with start/stop/delete controls.
 */
export function AutoScalerPanel() {
  const { autoScalers, setAutoScalers, agents, tabs, user, fetchAutoScalers } = useApp();
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
            <ModelCombobox id="autoScalerModel" value={model} onChange={setModel} placeholder="e.g. claude-sonnet-4-20250514" />
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
            onStart={() => handleStart(autoScaler.id)}
            onStop={() => handleStop(autoScaler.id)}
            onDelete={() => handleDelete(autoScaler.id)}
          />
        ))}
        {autoScalers.length === 0 && !showForm && (
          <li className="autoscaler-empty-hint">No auto-scalers yet. Create one to auto-scale sessions.</li>
        )}
      </ul>
    </div>
  );
}

function AutoScalerCard({ autoScaler, onStart, onStop, onDelete }: {
  autoScaler: AutoScaler;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const isRunning = autoScaler.status === 'running';

  return (
    <li className={`autoscaler-card${isRunning ? ' autoscaler-running' : ''}`} data-autoscaler-id={autoScaler.id}>
      <div className="autoscaler-card-header">
        <span className="autoscaler-card-name">{autoScaler.name}</span>
        <span className={`autoscaler-status-badge status-${autoScaler.status}`}>{autoScaler.status}</span>
      </div>
      <div className="autoscaler-card-meta">
        <span>Agent: {autoScaler.agentName}</span>
        <span>Max: {autoScaler.maxConcurrency === 0 ? '∞' : autoScaler.maxConcurrency}</span>
        {autoScaler.runningSessionCount !== undefined && (
          <span>Running: {autoScaler.runningSessionCount}</span>
        )}
      </div>
      <div className="autoscaler-card-controls">
        <button
          className="btn btn-success btn-sm"
          disabled={isRunning}
          onClick={onStart}
        >
          Start
        </button>
        <button
          className="btn btn-danger btn-sm"
          disabled={!isRunning}
          onClick={onStop}
        >
          Stop
        </button>
        <button
          className="btn btn-secondary btn-sm"
          disabled={isRunning}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
