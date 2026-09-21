import { useState, useRef, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

interface AgentImportModalProps {
  onClose: () => void;
}

/** Fields that are server-managed and must be stripped before POST */
const SERVER_FIELDS = ['id', 'userId', 'createdAt', 'updatedAt', 'tabIds'] as const;

/**
 * Validate the parsed agent object and return the first validation error,
 * or null if valid.
 */
function validateAgent(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Invalid JSON: expected a JSON object';
  }

  const obj = parsed as Record<string, unknown>;

  // 1. name — required, non-empty, matching /^[a-zA-Z0-9_-]+$/
  if (!('name' in obj) || obj.name === undefined || obj.name === null || obj.name === '') {
    return 'Missing required field: name';
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    return 'Missing required field: name';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(obj.name.trim())) {
    return 'name must only contain letters, numbers, dashes, and underscores';
  }

  // 2. prompt — required, non-empty
  if (!('prompt' in obj) || obj.prompt === undefined || obj.prompt === null || obj.prompt === '') {
    return 'Missing required field: prompt';
  }
  if (typeof obj.prompt !== 'string' || obj.prompt.trim() === '') {
    return 'Missing required field: prompt';
  }

  // 3. kind — if present, must be 'editor' or 'inspector'
  if ('kind' in obj && obj.kind !== undefined && obj.kind !== null) {
    if (obj.kind !== 'editor' && obj.kind !== 'inspector') {
      return "kind must be 'editor' or 'inspector'";
    }
  }

  // 4. mcpServers — if present, must be an array where each item has non-empty name and command
  if ('mcpServers' in obj && obj.mcpServers !== undefined && obj.mcpServers !== null) {
    if (!Array.isArray(obj.mcpServers)) {
      return 'mcpServers must be an array';
    }
    for (let i = 0; i < obj.mcpServers.length; i++) {
      const srv = obj.mcpServers[i];
      if (
        typeof srv !== 'object' || srv === null ||
        typeof (srv as Record<string, unknown>).name !== 'string' ||
        !(srv as Record<string, unknown>).name ||
        typeof (srv as Record<string, unknown>).command !== 'string' ||
        !(srv as Record<string, unknown>).command
      ) {
        return `mcpServers[${i}]: each server must have a non-empty name and command`;
      }
    }
  }

  return null;
}

/**
 * Try to parse JSON and return either an error message or the parsed value.
 */
function tryParseJson(text: string): { parsed: unknown; error: null } | { parsed: null; error: string } {
  try {
    const parsed = JSON.parse(text);
    return { parsed, error: null };
  } catch (e) {
    return { parsed: null, error: `Invalid JSON: ${(e as Error).message}` };
  }
}

/**
 * Strip server-managed fields from the payload before sending to POST /api/agents.
 */
function cleanPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const field of SERVER_FIELDS) {
    delete result[field];
  }
  return result;
}

export function AgentImportModal({ onClose }: AgentImportModalProps) {
  const { setAgents, setActiveAgentId } = useApp();
  const [jsonText, setJsonText] = useState('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live JSON parse feedback as the user types
  useEffect(() => {
    if (!jsonText.trim()) {
      setLiveError(null);
      return;
    }
    const { error } = tryParseJson(jsonText);
    setLiveError(error);
  }, [jsonText]);

  const loadFileContent = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setJsonText(content);
      setSubmitError(null);
    };
    reader.readAsText(file);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      loadFileContent(file);
    }
  }, [loadFileContent]);

  const handleBrowse = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadFileContent(file);
    }
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, [loadFileContent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (!jsonText.trim()) {
      setSubmitError('Missing required field: name');
      return;
    }

    // Parse JSON
    const { parsed, error: parseError } = tryParseJson(jsonText);
    if (parseError) {
      setSubmitError(parseError);
      return;
    }

    // Semantic validation
    const validationError = validateAgent(parsed);
    if (validationError) {
      setSubmitError(validationError);
      return;
    }

    // Clean payload
    const payload = cleanPayload(parsed as Record<string, unknown>);

    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
          else if (body?.message) message = body.message;
        } catch {
          // ignore parse error
        }
        setSubmitError(message);
        return;
      }

      const created = await res.json();
      setAgents(prev => [...prev, created]);
      setActiveAgentId(created.id);
      onClose();
    } catch (e) {
      setSubmitError('Failed to import agent: ' + (e as Error).message);
    }
  };

  // The visible error is the live parse error (while typing) or the submit error (on submit)
  const displayError = liveError ?? submitError;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" role="dialog" aria-labelledby="agentImportModalTitle">
        <h2 id="agentImportModalTitle">Import Agent</h2>

        <form onSubmit={handleSubmit}>
          {/* Drop zone */}
          <div
            className={`import-drop-zone${isDragOver ? ' drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <p>Drag &amp; drop a <code>.json</code> file here</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleBrowse}>
              Browse file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>

          {/* JSON textarea */}
          <div className="form-group">
            <label htmlFor="agentImportJson">Or paste JSON directly</label>
            <textarea
              id="agentImportJson"
              rows={12}
              placeholder='{ "name": "my-agent", "prompt": "You are..." }'
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setSubmitError(null);
              }}
            />
            {displayError && (
              <p className="form-error" role="alert">{displayError}</p>
            )}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Import Agent</button>
          </div>
        </form>
      </div>
    </div>
  );
}
