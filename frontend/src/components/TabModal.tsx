import { useState } from 'react';
import { apiFetch } from '../utils/api';
import type { Tab } from '../types';

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
  const [autoMergePrs, setAutoMergePrs] = useState(tab?.autoMergePrs === true);
  const [showAutoMergeConfirm, setShowAutoMergeConfirm] = useState(false);
  const [error, setError] = useState('');

  const handleAutoMergeToggle = () => {
    if (!autoMergePrs) {
      // Turning ON — show confirmation dialog
      setShowAutoMergeConfirm(true);
    } else {
      // Turning OFF — no confirmation needed
      setAutoMergePrs(false);
    }
  };

  const confirmAutoMerge = () => {
    setAutoMergePrs(true);
    setShowAutoMergeConfirm(false);
  };

  const cancelAutoMerge = () => {
    setShowAutoMergeConfirm(false);
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
          autoMergePrs,
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
    <>
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
            {isEditing && (
              <div className="form-group">
                <label>Automation</label>
                <small className="form-hint">Automate post-QA actions for this board.</small>
                <div className="mcp-toggles">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={autoMergePrs} onChange={handleAutoMergeToggle} />
                    <span>Auto-complete PRs</span>
                  </label>
                </div>
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary">{isEditing ? 'Save Changes' : 'Create Tab'}</button>
            </div>
          </form>
        </div>
      </div>

      {showAutoMergeConfirm && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) cancelAutoMerge(); }}>
          <div className="modal modal-confirm" role="dialog" aria-labelledby="confirmAutoMergeTitle">
            <h2 id="confirmAutoMergeTitle">Enable Auto-complete PRs?</h2>
            <p>
              Enabling Auto-complete PRs means the QA agent will automatically merge approved
              pull requests into the base branch and delete their source branches. This action
              is irreversible for PRs that have already been merged. Are you sure you want to
              enable this?
            </p>
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={cancelAutoMerge}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={confirmAutoMerge}>Enable</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
