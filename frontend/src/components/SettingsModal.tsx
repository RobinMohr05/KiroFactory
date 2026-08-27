import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { ViewModeSlider } from './ViewModeSlider';
import type { UiViewMode } from '../types';

interface CredentialStatus {
  [key: string]: boolean;
}

interface SettingsModalProps {
  onClose: () => void;
}

const CREDENTIAL_ROWS = [
  { key: 'azureDevOpsPat', label: 'Azure DevOps PAT', placeholder: 'Enter PAT...', type: 'password' as const, hint: '' },
  { key: 'githubPat', label: 'GitHub PAT', placeholder: 'ghp_... or github_pat_...', type: 'password' as const, hint: 'Needs repo scope (or Contents + Pull requests write for fine-grained tokens) so the worker can push branches and open pull requests.' },
  { key: 'atlassianUsername', label: 'Atlassian Username (email)', placeholder: 'you@example.com', type: 'text' as const, hint: '' },
  { key: 'atlassianApiToken', label: 'Atlassian API Token', placeholder: 'Enter token...', type: 'password' as const, hint: '' },
  { key: 'awsAccessKeyId', label: 'AWS Access Key ID', placeholder: 'AKIA...', type: 'password' as const, hint: '' },
  { key: 'awsSecretAccessKey', label: 'AWS Secret Access Key', placeholder: 'Enter secret key...', type: 'password' as const, hint: '' },
];

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { user, setUiViewMode } = useApp();

  // Change password state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ text: string; type: string } | null>(null);

  // Change API key state
  const [apiKeyPw, setApiKeyPw] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [apiKeyMsg, setApiKeyMsg] = useState<{ text: string; type: string } | null>(null);

  // Default git provider
  const [gitProvider, setGitProvider] = useState(user?.defaultGitProvider || 'auto');
  const [gitProviderMsg, setGitProviderMsg] = useState<{ text: string; type: string } | null>(null);

  // Delete account state
  const [deleteAccountPw, setDeleteAccountPw] = useState('');
  const [deleteAccountMsg, setDeleteAccountMsg] = useState<{ text: string; type: string } | null>(null);
  const [deleteConfirmPending, setDeleteConfirmPending] = useState(false);

  // Credentials state
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({});
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialMsgs, setCredentialMsgs] = useState<Record<string, { text: string; type: string }>>({});
  const [credentialDbUnavailable, setCredentialDbUnavailable] = useState(false);

  useEffect(() => {
    loadCredentialStatus();
  }, []);

  const loadCredentialStatus = async () => {
    try {
      const res = await apiFetch('/api/users/me/credentials');
      if (res.status === 503) {
        setCredentialDbUnavailable(true);
        return;
      }
      if (!res.ok) return;
      setCredentialDbUnavailable(false);
      const status: CredentialStatus = await res.json();
      setCredentialStatus(status);
    } catch (err) {
      console.error('Failed to load credential status:', err);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPw || !newPw) {
      setPasswordMsg({ text: 'Both fields are required.', type: 'error' });
      return;
    }
    if (newPw.length < 8) {
      setPasswordMsg({ text: 'New password must be at least 8 characters.', type: 'error' });
      return;
    }
    try {
      const res = await apiFetch('/api/auth/me/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      if (res.status === 401) {
        setPasswordMsg({ text: 'Current password is incorrect.', type: 'error' });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPasswordMsg({ text: data.error || 'Failed to update password.', type: 'error' });
        return;
      }
      setPasswordMsg({ text: 'Password updated successfully.', type: 'success' });
      setCurrentPw('');
      setNewPw('');
    } catch (err) {
      console.error('Change password error:', err);
      setPasswordMsg({ text: 'Network error. Please try again.', type: 'error' });
    }
  };

  const handleChangeApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyPw || !newApiKey) {
      setApiKeyMsg({ text: 'Both fields are required.', type: 'error' });
      return;
    }
    try {
      const res = await apiFetch('/api/auth/me/api-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: apiKeyPw, kiroApiKey: newApiKey }),
      });
      if (res.status === 401) {
        setApiKeyMsg({ text: 'Current password is incorrect.', type: 'error' });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setApiKeyMsg({ text: data.error || 'Failed to update API key.', type: 'error' });
        return;
      }
      setApiKeyMsg({ text: 'Kiro API key updated successfully.', type: 'success' });
      setApiKeyPw('');
      setNewApiKey('');
    } catch (err) {
      console.error('Change API key error:', err);
      setApiKeyMsg({ text: 'Network error. Please try again.', type: 'error' });
    }
  };

  const handleSaveGitProvider = async () => {
    const value = gitProvider === 'auto' ? null : gitProvider;
    try {
      const res = await apiFetch('/api/auth/me/default-git-provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultGitProvider: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setGitProviderMsg({ text: data.error || 'Failed to save default provider.', type: 'error' });
        return;
      }
      setGitProviderMsg({
        text: value ? `Default provider set to ${value}.` : 'Default provider cleared — detecting from repository URL.',
        type: 'success',
      });
    } catch (err) {
      console.error('Save default git provider error:', err);
      setGitProviderMsg({ text: 'Network error. Please try again.', type: 'error' });
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteAccountPw) {
      setDeleteAccountMsg({ text: 'Password is required to confirm deletion.', type: 'error' });
      return;
    }
    if (!deleteConfirmPending) {
      setDeleteConfirmPending(true);
      setTimeout(() => setDeleteConfirmPending(false), 3000);
      return;
    }
    setDeleteConfirmPending(false);
    try {
      const res = await apiFetch('/api/auth/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: deleteAccountPw }),
      });
      if (res.status === 401) {
        setDeleteAccountMsg({ text: 'Password is incorrect.', type: 'error' });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteAccountMsg({ text: data.error || 'Failed to delete account.', type: 'error' });
        return;
      }
      window.location.href = '/login.html';
    } catch (err) {
      console.error('Delete account error:', err);
      setDeleteAccountMsg({ text: 'Network error. Please try again.', type: 'error' });
    }
  };

  const handleCredentialUpdate = async (key: string) => {
    const value = credentialValues[key]?.trim();
    if (!value) {
      setCredentialMsgs(prev => ({ ...prev, [key]: { text: 'Please enter a value.', type: 'error' } }));
      return;
    }
    await saveCredential(key, value);
  };

  const handleCredentialClear = async (key: string) => {
    await saveCredential(key, null);
  };

  const saveCredential = async (key: string, value: string | null) => {
    try {
      const body: Record<string, string | null> = {};
      body[key] = value;
      const res = await apiFetch('/api/users/me/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 422 && data.validationErrors) {
          setCredentialMsgs(prev => ({ ...prev, [key]: { text: data.validationErrors[key] || 'Validation failed', type: 'error' } }));
          return;
        }
        if (res.status === 503) {
          setCredentialDbUnavailable(true);
          setCredentialMsgs(prev => ({ ...prev, [key]: { text: data.error || 'Database unavailable — your change was not saved.', type: 'error' } }));
          return;
        }
        setCredentialMsgs(prev => ({ ...prev, [key]: { text: data.error || 'Failed to save credential.', type: 'error' } }));
        return;
      }
      const data = await res.json().catch(() => ({}));
      const warning = data?.warnings?.[key];
      if (value === null) {
        setCredentialMsgs(prev => ({ ...prev, [key]: { text: 'Cleared.', type: 'success' } }));
        setCredentialStatus(prev => ({ ...prev, [key]: false }));
      } else {
        setCredentialMsgs(prev => ({ ...prev, [key]: { text: warning || 'Saved & validated.', type: warning ? 'warning' : 'success' } }));
        setCredentialStatus(prev => ({ ...prev, [key]: true }));
        setCredentialValues(prev => ({ ...prev, [key]: '' }));
      }
    } catch (err) {
      console.error(`Save credential ${key} error:`, err);
      setCredentialMsgs(prev => ({ ...prev, [key]: { text: 'Network error. Please try again.', type: 'error' } }));
    }
  };

  const createdDate = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-labelledby="settingsModalTitle">
        <h2 id="settingsModalTitle">Profile & Settings</h2>
        <div className="settings-profile-info">
          {user ? (
            <>
              <p><strong>Email:</strong> {user.email}</p>
              <p><strong>Member since:</strong> {createdDate}</p>
            </>
          ) : (
            <p>Not logged in</p>
          )}
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">Interface Mode</h3>
          <p className="credentials-description">
            Easy mode gives you a simple chat-style view for getting started. Advanced mode
            unlocks the full board/sessions/agents workflow for loop engineering. Switching
            requires confirmation either way.
          </p>
          <ViewModeSlider<UiViewMode>
            steps={[
              { value: 'easy', label: 'Easy' },
              { value: 'advanced', label: 'Advanced' },
            ]}
            value={user?.uiViewMode || 'easy'}
            onConfirm={setUiViewMode}
          />
        </div>

        <form className="settings-section" onSubmit={handleChangePassword}>
          <h3 className="settings-section-title">Change Password</h3>
          <div className="form-group">
            <label htmlFor="settingsCurrentPw">Current Password</label>
            <input type="password" id="settingsCurrentPw" required placeholder="••••••••" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="settingsNewPw">New Password</label>
            <input type="password" id="settingsNewPw" required placeholder="At least 8 characters" minLength={8} autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          {passwordMsg && <div className={`form-message ${passwordMsg.type}`}>{passwordMsg.text}</div>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm">Update Password</button>
          </div>
        </form>

        <form className="settings-section" onSubmit={handleChangeApiKey}>
          <h3 className="settings-section-title">Update Kiro API Key</h3>
          <div className="form-group">
            <label htmlFor="settingsApiKeyPw">Current Password</label>
            <input type="password" id="settingsApiKeyPw" required placeholder="••••••••" autoComplete="current-password" value={apiKeyPw} onChange={(e) => setApiKeyPw(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="settingsNewApiKey">New Kiro API Key</label>
            <input type="password" id="settingsNewApiKey" required placeholder="Your new Kiro API key" autoComplete="off" value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} />
          </div>
          {apiKeyMsg && <div className={`form-message ${apiKeyMsg.type}`}>{apiKeyMsg.text}</div>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-sm">Update API Key</button>
          </div>
        </form>

        <div className="settings-section">
          <h3 className="settings-section-title">Default Git Provider</h3>
          <p className="credentials-description">Used for repositories whose host can&apos;t be recognised from the URL and that don&apos;t select a provider themselves. Each tab can override this.</p>
          <div className="form-group">
            <label htmlFor="settingsDefaultGitProvider">Default provider</label>
            <select id="settingsDefaultGitProvider" value={gitProvider} onChange={(e) => setGitProvider(e.target.value)}>
              <option value="auto">Detect from repository URL</option>
              <option value="github">GitHub</option>
              <option value="azure-devops">Azure DevOps</option>
            </select>
          </div>
          {gitProviderMsg && <div className={`form-message ${gitProviderMsg.type}`}>{gitProviderMsg.text}</div>}
          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveGitProvider}>Save Default</button>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">Service Credentials</h3>
          <p className="credentials-description">Credentials are encrypted at rest and only decrypted when spawning a worker. Values are never sent back to the browser.</p>

          {credentialDbUnavailable && (
            <div className="credential-db-banner">
              Database unavailable — credentials can&apos;t be saved right now. Your changes won&apos;t persist until the connection is restored.
            </div>
          )}

          {CREDENTIAL_ROWS.map(({ key, label, placeholder, type, hint }) => (
            <div className="credential-row" key={key} data-key={key}>
              <label>{label}</label>
              <div className="credential-input-row">
                <input
                  type={type}
                  placeholder={credentialStatus[key] ? '••••••••' : placeholder}
                  autoComplete="off"
                  disabled={credentialDbUnavailable}
                  value={credentialValues[key] || ''}
                  onChange={(e) => setCredentialValues(prev => ({ ...prev, [key]: e.target.value }))}
                />
                <span className={`credential-status ${credentialStatus[key] ? 'is-set' : 'not-set'}`} title={credentialStatus[key] ? 'Set' : 'Not set'}>
                  {credentialStatus[key] ? '●' : '○'}
                </span>
                <button type="button" className="btn btn-primary btn-sm" disabled={credentialDbUnavailable} onClick={() => handleCredentialUpdate(key)}>Update</button>
                <button type="button" className="btn btn-danger btn-sm credential-clear-btn" title="Clear" disabled={credentialDbUnavailable} onClick={() => handleCredentialClear(key)}>✕</button>
              </div>
              {hint && <div className="credential-hint">{hint}</div>}
              {credentialMsgs[key] && <div className={`form-message credential-msg ${credentialMsgs[key].type}`}>{credentialMsgs[key].text}</div>}
            </div>
          ))}
        </div>

        <div className="settings-section settings-danger-zone">
          <h3 className="settings-section-title danger-title">Danger Zone</h3>
          <p className="danger-description">Permanently delete your account and all associated data. This action cannot be undone.</p>
          <form onSubmit={handleDeleteAccount}>
            <div className="form-group">
              <label htmlFor="deleteAccountPw">Confirm Password</label>
              <input type="password" id="deleteAccountPw" required placeholder="Enter your password to confirm" autoComplete="current-password" value={deleteAccountPw} onChange={(e) => setDeleteAccountPw(e.target.value)} />
            </div>
            {deleteAccountMsg && <div className={`form-message ${deleteAccountMsg.type}`}>{deleteAccountMsg.text}</div>}
            <div className="form-actions">
              <button type="submit" className={`btn btn-danger btn-sm${deleteConfirmPending ? ' btn-confirm-pending' : ''}`}>
                {deleteConfirmPending ? 'Click again to confirm' : 'Delete My Account'}
              </button>
            </div>
          </form>
        </div>

        <div className="form-actions" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
