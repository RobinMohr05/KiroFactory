import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import type { Agent } from '../types';

interface SessionModalProps {
  onClose: () => void;
}

export function SessionModal({ onClose }: SessionModalProps) {
  const { tabs, currentTabId, setSessions, setActiveSessionId } = useApp();
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [interactive, setInteractive] = useState(true);
  const [runs, setRuns] = useState(0);
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const [selectedBoardIds, setSelectedBoardIds] = useState<number[]>(currentTabId ? [currentTabId] : []);
  const [agents, setAgentsList] = useState<Agent[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/agents');
        if (res.ok) setAgentsList(await res.json());
      } catch { /* ignore */ }
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const isAgentless = !agent;
    const loop = isAgentless ? false : true;
    const effectiveInteractive = isAgentless ? true : interactive;

    const boardIds = [...selectedBoardIds];
    if (currentTabId && !boardIds.includes(currentTabId)) {
      boardIds.push(currentTabId);
    }

    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        prompt: prompt.trim() || undefined,
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
        interactive: effectiveInteractive,
        loop,
        runs: isAgentless ? 0 : runs,
        intervalSeconds,
        tabIds: boardIds.length > 0 ? boardIds : undefined,
      };
      if (agent) body.agent = agent;

      const res = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const session = await res.json();
      setSessions(prev => {
        if (prev.find(s => s.id === session.id)) return prev;
        return [...prev, session];
      });
      setActiveSessionId(session.id);

      // Auto-start
      await apiFetch(`/api/sessions/${session.id}/start`, { method: 'POST' });
      onClose();
    } catch (e) {
      console.error('Failed to create session:', e);
      alert('Failed to create session: ' + (e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-labelledby="sessionModalTitle">
        <h2 id="sessionModalTitle">New Agent Session</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="sessionName">Session Name</label>
            <input type="text" id="sessionName" required placeholder="e.g. Feature Builder" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label htmlFor="sessionAgent">Agent <small>(optional)</small></label>
            <select id="sessionAgent" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">None (interactive)</option>
              {agents.map(a => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="sessionPrompt">Task <small>(optional)</small></label>
            <textarea id="sessionPrompt" rows={4} placeholder="Leave empty for default prompt, or describe a task..." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
              <span>Interactive — allow follow-up prompts</span>
            </label>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sessionRuns">Runs <small>(0 = endless)</small></label>
              <input type="number" id="sessionRuns" min="0" value={runs} onChange={(e) => setRuns(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label htmlFor="sessionInterval">Interval (seconds)</label>
              <input type="number" id="sessionInterval" min="0" value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sessionCwd">Working Directory</label>
              <input type="text" id="sessionCwd" placeholder="Defaults to project root" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="sessionModel">Model</label>
              <input type="text" id="sessionModel" placeholder="e.g. claude-sonnet-4" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="sessionBoards">Assign to Tabs <small>(select one or more)</small></label>
            <select
              id="sessionBoards"
              multiple
              size={3}
              value={selectedBoardIds.map(String)}
              onChange={(e) => setSelectedBoardIds(Array.from(e.target.selectedOptions).map(o => Number(o.value)))}
            >
              {tabs.map(tab => (
                <option key={tab.id} value={tab.id}>{tab.name}</option>
              ))}
            </select>
            <small className="form-hint">Hold Ctrl/Cmd to select multiple. In loop mode, claims tasks from these tabs.</small>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create & Start</button>
          </div>
        </form>
      </div>
    </div>
  );
}
