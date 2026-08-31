import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { DEFAULT_MCP_CONFIG } from '../utils/api';
import type { Agent, Session, McpConfig, McpServerConfig } from '../types';

interface SessionModalProps {
  session?: Session | null; // null/undefined = creating new, Session = editing
  onClose: () => void;
}

export function SessionModal({ session, onClose }: SessionModalProps) {
  const { tabs, currentTabId, setSessions, setActiveSessionId } = useApp();
  const isEditing = !!session;

  const [name, setName] = useState(session?.name || '');
  const [agent, setAgent] = useState(session?.agent || '');
  const [prompt, setPrompt] = useState(session?.prompt || '');
  const [cwd, setCwd] = useState(session?.cwd || '');
  const [model, setModel] = useState(session?.model || '');
  const [timeoutSeconds, setTimeoutSeconds] = useState(session?.timeoutSeconds ?? 0);
  const [interactive, setInteractive] = useState(session?.interactive !== false);
  const [loop, setLoop] = useState(session?.loop ?? true);
  const [runs, setRuns] = useState(session?.runs ?? 0);
  const [intervalSeconds, setIntervalSeconds] = useState(session?.intervalSeconds ?? 10);
  const [selectedBoardIds, setSelectedBoardIds] = useState<number[]>(
    session?.tabIds || (currentTabId ? [currentTabId] : [])
  );
  const [agents, setAgentsList] = useState<Agent[]>([]);

  // MCP config override
  const [mcpConfig, setMcpConfig] = useState<McpConfig>(
    session?.mcpConfigOverride || { ...DEFAULT_MCP_CONFIG }
  );
  const [mcpSectionExpanded, setMcpSectionExpanded] = useState(false);

  // Agent MCP servers exclusions
  const [excludedNames, setExcludedNames] = useState<string[]>(
    session?.excludedMcpServerNames ?? []
  );
  const [agentMcpSectionExpanded, setAgentMcpSectionExpanded] = useState(false);

  // Custom MCP servers
  const [customMcpServers, setCustomMcpServers] = useState<McpServerConfig[]>(
    session?.mcpServers || []
  );
  const [customMcpSectionExpanded, setCustomMcpSectionExpanded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/agents');
        if (res.ok) setAgentsList(await res.json());
      } catch { /* ignore */ }
    })();
  }, []);

  const handleMcpToggle = (key: keyof McpConfig) => {
    setMcpConfig(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const addCustomMcpServer = () => {
    setCustomMcpServers(prev => [...prev, { name: '', command: '', args: [], env: [] }]);
  };

  const removeCustomMcpServer = (idx: number) => {
    setCustomMcpServers(prev => prev.filter((_, i) => i !== idx));
  };

  const updateCustomMcpServer = (idx: number, field: string, value: string) => {
    setCustomMcpServers(prev => prev.map((s, i) => {
      if (i !== idx) return s;
      if (field === 'name' || field === 'command') return { ...s, [field]: value };
      if (field === 'args') return { ...s, args: value ? value.split(/\s+/) : [] };
      if (field === 'env') {
        const env = value
          ? value.split(',').map(l => l.trim()).filter(Boolean).map(pair => {
              const eqIdx = pair.indexOf('=');
              return eqIdx === -1
                ? { name: pair, value: '' }
                : { name: pair.slice(0, eqIdx).trim(), value: pair.slice(eqIdx + 1).trim() };
            })
          : [];
        return { ...s, env };
      }
      return s;
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const isAgentless = !agent;
    const effectiveLoop = isAgentless ? false : loop;
    const effectiveInteractive = isAgentless ? true : interactive;

    const boardIds = [...selectedBoardIds];
    if (currentTabId && !boardIds.includes(currentTabId)) {
      boardIds.push(currentTabId);
    }

    const mcpServers = customMcpServers.filter(s => s.name.trim() && s.command.trim());

    try {
      if (isEditing) {
        // Update existing session via PATCH
        const body: Record<string, unknown> = {
          name: name.trim(),
          prompt: prompt.trim() || null,
          cwd: cwd.trim() || null,
          model: model.trim() || null,
          timeoutSeconds: timeoutSeconds || 0,
          interactive: effectiveInteractive,
          loop: effectiveLoop,
          runs: isAgentless ? 0 : runs,
          intervalSeconds,
          tabIds: boardIds.length > 0 ? boardIds : [],
          mcpConfigOverride: mcpConfig,
          mcpServers: mcpServers.length > 0 ? mcpServers : null,
          excludedMcpServerNames: excludedNames,
        };
        if (agent) body.agent = agent;

        const res = await apiFetch(`/api/sessions/${session!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 409) {
          alert('Cannot edit a running session. Stop the session first.');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated = await res.json();
        setSessions(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
        onClose();
      } else {
        // Create new session
        const body: Record<string, unknown> = {
          name: name.trim(),
          prompt: prompt.trim() || undefined,
          cwd: cwd.trim() || undefined,
          model: model.trim() || undefined,
          timeoutSeconds: timeoutSeconds || undefined,
          interactive: effectiveInteractive,
          loop: effectiveLoop,
          runs: isAgentless ? 0 : runs,
          intervalSeconds,
          tabIds: boardIds.length > 0 ? boardIds : undefined,
          mcpConfigOverride: mcpConfig,
          mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
          excludedMcpServerNames: excludedNames.length > 0 ? excludedNames : undefined,
        };
        if (agent) body.agent = agent;

        const res = await apiFetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const newSession = await res.json();
        setSessions(prev => {
          if (prev.find(s => s.id === newSession.id)) return prev;
          return [...prev, newSession];
        });
        setActiveSessionId(newSession.id);

        // Auto-start
        await apiFetch(`/api/sessions/${newSession.id}/start`, { method: 'POST' });
        onClose();
      }
    } catch (e) {
      console.error('Failed to save session:', e);
      alert('Failed to save session: ' + (e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-labelledby="sessionModalTitle">
        <h2 id="sessionModalTitle">{isEditing ? 'Edit Session' : 'New Agent Session'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="sessionName">Session Name</label>
            <input type="text" id="sessionName" required placeholder="e.g. Feature Builder" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label htmlFor="sessionAgent">Agent <small>(optional)</small></label>
            <select id="sessionAgent" value={agent} onChange={(e) => { setAgent(e.target.value); setExcludedNames([]); }}>
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
          <div className="form-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              <span>Loop — repeat on interval</span>
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
            <label htmlFor="sessionTimeout">Timeout (seconds) <small>(0 = default)</small></label>
            <input type="number" id="sessionTimeout" min="0" value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} />
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

          {/* Agent MCP Servers section */}
          {(() => {
            const selectedAgent = agents.find(a => a.name === agent);
            const agentServers = selectedAgent?.mcpServers ?? [];
            if (agentServers.length === 0) return null;
            return (
              <div className="form-group">
                <button
                  type="button"
                  className="collapsible-toggle"
                  aria-expanded={agentMcpSectionExpanded}
                  onClick={() => setAgentMcpSectionExpanded(!agentMcpSectionExpanded)}
                >
                  <span className="toggle-icon">{agentMcpSectionExpanded ? '▼' : '▶'}</span> Agent MCP Servers
                </button>
                {agentMcpSectionExpanded && (
                  <div className="collapsible-content">
                    {agentServers.map(server => {
                      const isExcluded = excludedNames.includes(server.name);
                      return (
                        <label key={server.name} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => {
                              if (isExcluded) {
                                setExcludedNames(prev => prev.filter(n => n !== server.name));
                              } else {
                                setExcludedNames(prev => [...prev, server.name]);
                              }
                            }}
                          />
                          <span>{server.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* MCP Servers section */}
          <div className="form-group">
            <button
              type="button"
              className="collapsible-toggle"
              aria-expanded={mcpSectionExpanded}
              onClick={() => setMcpSectionExpanded(!mcpSectionExpanded)}
            >
              <span className="toggle-icon">{mcpSectionExpanded ? '▼' : '▶'}</span> MCP Servers
            </button>
            {mcpSectionExpanded && (
              <div className="collapsible-content">
                <div className="mcp-toggles">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={mcpConfig.atlassian} onChange={() => handleMcpToggle('atlassian')} />
                    <span>Atlassian</span>
                  </label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={mcpConfig.azureDevops} onChange={() => handleMcpToggle('azureDevops')} />
                    <span>Azure DevOps</span>
                  </label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={mcpConfig.awsApi} onChange={() => handleMcpToggle('awsApi')} />
                    <span>AWS API</span>
                  </label>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={mcpConfig.awsDocs} onChange={() => handleMcpToggle('awsDocs')} />
                    <span>AWS Docs</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Custom MCP Servers section */}
          <div className="form-group">
            <button
              type="button"
              className="collapsible-toggle"
              aria-expanded={customMcpSectionExpanded}
              onClick={() => setCustomMcpSectionExpanded(!customMcpSectionExpanded)}
            >
              <span className="toggle-icon">{customMcpSectionExpanded ? '▼' : '▶'}</span> Custom MCP Servers
            </button>
            {customMcpSectionExpanded && (
              <div className="collapsible-content">
                {customMcpServers.map((server, idx) => (
                  <div key={idx} className="custom-mcp-entry">
                    <input
                      type="text"
                      className="custom-mcp-name"
                      placeholder="Name"
                      value={server.name}
                      onChange={(e) => updateCustomMcpServer(idx, 'name', e.target.value)}
                    />
                    <input
                      type="text"
                      className="custom-mcp-command"
                      placeholder="Command"
                      value={server.command}
                      onChange={(e) => updateCustomMcpServer(idx, 'command', e.target.value)}
                    />
                    <input
                      type="text"
                      className="custom-mcp-args"
                      placeholder="Args (space-separated)"
                      value={server.args.join(' ')}
                      onChange={(e) => updateCustomMcpServer(idx, 'args', e.target.value)}
                    />
                    <input
                      type="text"
                      className="custom-mcp-env"
                      placeholder="Env (KEY=VAL, ...)"
                      value={server.env.map(e => `${e.name}=${e.value}`).join(', ')}
                      onChange={(e) => updateCustomMcpServer(idx, 'env', e.target.value)}
                    />
                    <button type="button" className="btn btn-danger btn-sm custom-mcp-remove" onClick={() => removeCustomMcpServer(idx)}>×</button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomMcpServer}>+ Add MCP Server</button>
              </div>
            )}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEditing ? 'Save Changes' : 'Create & Start'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
