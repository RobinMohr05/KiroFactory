import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import type { Agent } from '../types';

interface AgentModalProps {
  agent: Agent | null; // null = creating
  onClose: () => void;
}

export function AgentModal({ agent, onClose }: AgentModalProps) {
  const { setAgents, setActiveAgentId } = useApp();
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [prompt, setPrompt] = useState(agent?.prompt || '');
  const [tools, setTools] = useState(agent?.tools?.join(', ') || '');
  const [allowedTools, setAllowedTools] = useState(agent?.allowedTools?.join(', ') || '');
  const [resources, setResources] = useState(agent?.resources?.join('\n') || '');
  const [kind, setKind] = useState<'editor' | 'inspector'>(agent?.kind || 'editor');
  const [requiresTask, setRequiresTask] = useState(agent?.requiresTask !== false);
  const [claimState, setClaimState] = useState(agent?.claimState || '');
  const [workingState, setWorkingState] = useState(agent?.workingState || '');
  const [resolveState, setResolveState] = useState(agent?.resolveState || '');
  const [settings, setSettings] = useState(
    agent?.toolsSettings && Object.keys(agent.toolsSettings).length > 0
      ? JSON.stringify(agent.toolsSettings, null, 2)
      : ''
  );
  const [mcpServersJson, setMcpServersJson] = useState(
    agent?.mcpServers?.length
      ? JSON.stringify(agent.mcpServers, null, 2)
      : ''
  );

  const isEditing = !!agent;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) return;

    let toolsSettings: Record<string, unknown> = {};
    if (settings.trim()) {
      try {
        toolsSettings = JSON.parse(settings.trim());
      } catch {
        alert('Tools Settings must be valid JSON');
        return;
      }
    }

    let mcpServers: unknown[] = [];
    if (mcpServersJson.trim()) {
      try {
        mcpServers = JSON.parse(mcpServersJson.trim());
        if (!Array.isArray(mcpServers)) {
          alert('MCP Servers must be a JSON array');
          return;
        }
      } catch {
        alert('MCP Servers must be valid JSON');
        return;
      }
    }

    const data = {
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      tools: tools ? tools.split(',').map(s => s.trim()).filter(Boolean) : [],
      allowedTools: allowedTools ? allowedTools.split(',').map(s => s.trim()).filter(Boolean) : [],
      resources: resources ? resources.split('\n').map(s => s.trim()).filter(Boolean) : [],
      toolsSettings,
      mcpServers,
      kind,
      requiresTask,
      claimState: claimState.trim() || null,
      workingState: workingState.trim() || null,
      resolveState: resolveState.trim() || null,
    };

    try {
      if (isEditing) {
        const res = await apiFetch(`/api/agents/${agent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated = await res.json();
        setAgents(prev => prev.map(a => a.id === agent.id ? updated : a));
      } else {
        const res = await apiFetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const created = await res.json();
        setAgents(prev => [...prev, created]);
        setActiveAgentId(created.id);
      }
      onClose();
    } catch (e) {
      console.error('Failed to save agent:', e);
      alert('Failed to save agent: ' + (e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide" role="dialog" aria-labelledby="agentModalTitle">
        <h2 id="agentModalTitle">{isEditing ? 'Edit Agent' : 'New Agent'}</h2>
        <form onSubmit={handleSubmit} className="agent-form-section">
          <div className="form-group">
            <label htmlFor="agentFormName">Name <span className="required">*</span></label>
            <input type="text" id="agentFormName" required placeholder="e.g. code-reviewer" pattern="[a-zA-Z0-9_-]+" title="Only letters, numbers, dashes, and underscores" value={name} onChange={(e) => setName(e.target.value)} />
            <small className="form-hint">Used as the file name. Only letters, numbers, dashes, underscores.</small>
          </div>
          <div className="form-group">
            <label htmlFor="agentFormDescription">Description</label>
            <textarea id="agentFormDescription" rows={2} placeholder="What does this agent do?" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="agentFormPrompt">System Prompt <span className="required">*</span></label>
            <textarea id="agentFormPrompt" rows={8} required placeholder="Instructions for the agent..." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agentFormTools">Tools <small>(comma-separated)</small></label>
              <input type="text" id="agentFormTools" placeholder="read, write, shell, grep, glob, code" value={tools} onChange={(e) => setTools(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="agentFormAllowed">Allowed Tools <small>(comma-separated)</small></label>
              <input type="text" id="agentFormAllowed" placeholder="read, grep, glob, code" value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="agentFormResources">Resources <small>(one per line)</small></label>
            <textarea id="agentFormResources" rows={3} placeholder={"file://src/**/*.ts\nfile://README.md"} value={resources} onChange={(e) => setResources(e.target.value)} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agentFormKind">Kind</label>
              <select id="agentFormKind" value={kind} onChange={(e) => setKind(e.target.value as 'editor' | 'inspector')}>
                <option value="editor">Editor (changes code)</option>
                <option value="inspector">Inspector (reviews only)</option>
              </select>
            </div>
            <div className="form-group">
              <label className="checkbox-label">
                <input type="checkbox" checked={requiresTask} onChange={(e) => setRequiresTask(e.target.checked)} />
                <span>Requires a task to run</span>
              </label>
              <small className="form-hint">Off = agent loops on its own prompt, ignoring the task queue.</small>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agentFormClaimState">Claim State</label>
              <input type="text" id="agentFormClaimState" placeholder="e.g. todo" value={claimState} onChange={(e) => setClaimState(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="agentFormWorkingState">Working State</label>
              <input type="text" id="agentFormWorkingState" placeholder="e.g. in-progress" value={workingState} onChange={(e) => setWorkingState(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="agentFormResolveState">Resolve State</label>
            <input type="text" id="agentFormResolveState" placeholder="e.g. developed" value={resolveState} onChange={(e) => setResolveState(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="agentFormSettings">Tools Settings <small>(JSON)</small></label>
            <textarea id="agentFormSettings" rows={4} placeholder='{"shell": {"allowedCommands": ["npm run build"]}}' value={settings} onChange={(e) => setSettings(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="agentFormMcpServers">MCP Servers <small>(JSON)</small></label>
            <textarea id="agentFormMcpServers" rows={4} placeholder={'[{"name": "my-server", "command": "npx", "args": ["-y", "my-mcp-pkg"], "env": [{"name": "API_KEY", "value": "..."}]}]'} value={mcpServersJson} onChange={(e) => setMcpServersJson(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEditing ? 'Update Agent' : 'Create Agent'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
