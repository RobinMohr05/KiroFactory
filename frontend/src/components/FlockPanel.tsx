import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import type { Flock } from '../types';

/**
 * Flock controls panel — rendered inside the SessionsPanel sidebar only when
 * the user's uiViewMode is 'looper'. Shows a form to create a new Flock and
 * a list of existing Flocks with start/stop/delete controls.
 */
export function FlockPanel() {
  const { flocks, setFlocks, agents, tabs, user, fetchFlocks } = useApp();
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
      const res = await apiFetch('/api/flocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agentName,
          tabIds: selectedTabIds,
          model: model.trim() || undefined,
          maxConcurrency,
          idleTimeoutSeconds,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error || 'Failed to create flock');
        return;
      }
      setShowForm(false);
      setName('');
      setAgentName('');
      setSelectedTabIds([]);
      setModel('');
      setMaxConcurrency(5);
      setIdleTimeoutSeconds(30);
      await fetchFlocks();
    } catch (err) {
      setFormError('Network error');
    }
  };

  const handleStart = async (flockId: number) => {
    try {
      await apiFetch(`/api/flocks/${flockId}/start`, { method: 'POST' });
    } catch { /* WS update will reflect state */ }
  };

  const handleStop = async (flockId: number) => {
    try {
      await apiFetch(`/api/flocks/${flockId}/stop`, { method: 'POST' });
    } catch { /* WS update will reflect state */ }
  };

  const handleDelete = async (flockId: number) => {
    try {
      await apiFetch(`/api/flocks/${flockId}`, { method: 'DELETE' });
      setFlocks(prev => prev.filter(f => f.id !== flockId));
    } catch { /* ignore */ }
  };

  const handleTabToggle = (tabId: number) => {
    setSelectedTabIds(prev =>
      prev.includes(tabId) ? prev.filter(id => id !== tabId) : [...prev, tabId]
    );
  };

  return (
    <div className="flock-panel" data-testid="flock-panel">
      <div className="flock-panel-header">
        <h4>Flocks</h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Flock'}
        </button>
      </div>

      {showForm && (
        <form className="flock-create-form" onSubmit={handleCreate}>
          <div className="form-group">
            <label htmlFor="flockName">Name</label>
            <input
              id="flockName"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Flock"
            />
          </div>
          <div className="form-group">
            <label htmlFor="flockAgent">Agent</label>
            <select id="flockAgent" value={agentName} onChange={e => setAgentName(e.target.value)}>
              <option value="">Select agent...</option>
              {agents.map(a => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Tabs</label>
            <div className="flock-tab-checkboxes">
              {tabs.map(t => (
                <label key={t.id} className="flock-tab-checkbox">
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
            <label htmlFor="flockModel">Model (optional)</label>
            <input
              id="flockModel"
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-20250514"
            />
          </div>
          <div className="form-group">
            <label htmlFor="flockMaxConcurrency">Max Concurrency (0 = unlimited)</label>
            <input
              id="flockMaxConcurrency"
              type="number"
              min={0}
              value={maxConcurrency}
              onChange={e => setMaxConcurrency(Number(e.target.value))}
            />
          </div>
          <div className="form-group">
            <label htmlFor="flockIdleTimeout">Idle Timeout (seconds)</label>
            <input
              id="flockIdleTimeout"
              type="number"
              min={0}
              value={idleTimeoutSeconds}
              onChange={e => setIdleTimeoutSeconds(Number(e.target.value))}
            />
          </div>
          {formError && <div className="form-message error">{formError}</div>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm">Create Flock</button>
          </div>
        </form>
      )}

      <ul className="flock-list">
        {flocks.map(flock => (
          <FlockCard
            key={flock.id}
            flock={flock}
            onStart={() => handleStart(flock.id)}
            onStop={() => handleStop(flock.id)}
            onDelete={() => handleDelete(flock.id)}
          />
        ))}
        {flocks.length === 0 && !showForm && (
          <li className="flock-empty-hint">No flocks yet. Create one to auto-scale sessions.</li>
        )}
      </ul>
    </div>
  );
}

function FlockCard({ flock, onStart, onStop, onDelete }: {
  flock: Flock;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const isRunning = flock.status === 'running';

  return (
    <li className={`flock-card${isRunning ? ' flock-running' : ''}`} data-flock-id={flock.id}>
      <div className="flock-card-header">
        <span className="flock-card-name">{flock.name}</span>
        <span className={`flock-status-badge status-${flock.status}`}>{flock.status}</span>
      </div>
      <div className="flock-card-meta">
        <span>Agent: {flock.agentName}</span>
        <span>Max: {flock.maxConcurrency === 0 ? '∞' : flock.maxConcurrency}</span>
        {flock.runningSessionCount !== undefined && (
          <span>Running: {flock.runningSessionCount}</span>
        )}
      </div>
      <div className="flock-card-controls">
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
