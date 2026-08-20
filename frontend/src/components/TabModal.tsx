import { useState } from 'react';
import { apiFetch, DEFAULT_MCP_CONFIG } from '../utils/api';
import type { Tab, McpConfig } from '../types';

interface TabModalProps {
  tab?: Tab | null; // null = creating new, Tab = editing
  onClose: () => void;
  onSave: (tab: Tab) => void;
}

export function TabModal({ tab, onClose, onSave }: TabModalProps) {
  const isEditing = !!tab;
  const [name, setName] = useState(tab?.name || '');
  const [repositoryUrl, setRepositoryUrl] = useState(tab?.repositoryUrl || '');
  const [gitProvider, setGitProvider] = useState(tab?.gitProvider || '');
  const [mcpConfig, setMcpConfig] = useState<McpConfig>(
    tab?.mcpConfig || { ...DEFAULT_MCP_CONFIG }
  );
  const [error, setError] = useState('');

  const handleMcpToggle = (key: keyof McpConfig) => {
    setMcpConfig(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');

    try {
      if (isEditing) {
        const body: Record<string, unknown> = {
          name: name.trim(),
          repositoryUrl: repositoryUrl.trim() || null,
          gitProvider: gitProvider || null,
          mcpConfig,
        };
        const res = await apiFetch(`/api/tabs/${tab!.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        onSave(updated);
      } else {
        const body: Record<string, unknown> = {
          name: name.trim(),
          repositoryUrl: repositoryUrl.trim() || null,
          gitProvider: gitProvider || null,
        };
        const res = await apiFetch('/api/tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const created = await res.json();
        onSave(created);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save tab.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-labelledby="tabModalTitle">
        <h2 id="tabModalTitle">{isEditing ? 'Edit Tab' : 'New Tab'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="tabFormName">Tab Name</label>
            <input type="text" id="tabFormName" required placeholder="e.g. My Project" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="form-group">
            <label htmlFor="tabFormRepo">Repository URL</label>
            <input type="text" id="tabFormRepo" placeholder="https://github.com/user/repo" value={repositoryUrl} onChange={(e) => setRepositoryUrl(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="tabFormGitProvider">Git Provider</label>
            <select id="tabFormGitProvider" value={gitProvider} onChange={(e) => setGitProvider(e.target.value)}>
              <option value="">Auto-detect from URL</option>
              <option value="github">GitHub</option>
              <option value="azure-devops">Azure DevOps</option>
            </select>
          </div>
          <div className="form-group">
            <label>MCP Servers</label>
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
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEditing ? 'Save Changes' : 'Create Tab'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
