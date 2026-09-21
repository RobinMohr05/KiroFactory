import { useState, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

interface AgentImportModalProps {
  onClose: () => void;
}

/** Fields that are server-managed and must be stripped before import */
const SERVER_FIELDS = ['id', 'userId', 'createdAt', 'updatedAt', 'tabIds'] as const;

/** Validate the parsed agent object. Returns an error string or null if valid. */
function validateAgentPayload(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return 'JSON must be an object';
  }

  const record = obj as Record<string, unknown>;

  // 1. name must be a non-empty string matching /^[a-zA-Z0-9_-]+$/
  if (!('name' in record) || typeof record.name !== 'string' || record.name.trim() === '') {
    return 'Missing required field: name';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(record.name)) {
    return 'name must only contain letters, numbers, dashes, and underscores';
  }

  // 2. prompt must be a non-empty string
  if (!('prompt' in record) || typeof record.prompt !== 'string' || record.prompt.trim() === '') {
    return 'Missing required field: prompt';
  }

  // 3. kind, if present, must be "editor" or "inspector"
  if ('kind' in record && record.kind !== undefined && record.kind !== 'editor' && record.kind !== 'inspector') {
    return "kind must be 'editor' or 'inspector'";
  }

  // 4. mcpServers, if present, must be an array where each item has non-empty name and command
  if ('mcpServers' in record && record.mcpServers !== undefined) {
    if (!Array.isArray(record.mcpServers)) {
      return 'mcpServers must be an array';
    }
    for (let i = 0; i < record.mcpServers.length; i++) {
      const server = record.mcpServers[i];
      if (
        typeof server !== 'object' ||
        server === null ||
        typeof (server as Record<string, unknown>).name !== 'string' ||
        ((server as Record<string, unknown>).name as string).trim() === '' ||
        typeof (server as Record<string, unknown>).command !== 'string' ||
        ((server as Record<string, unknown>).command as string).trim() === ''
      ) {
        return `mcpServers[${i}]: each server must have a non-empty name and command`;
      }
    }
  }

  return null;
}

/** Parse JSON from a string. Returns { parsed, error }. */
function tryParseJson(text: string): { parsed: unknown; error: string | null } {
  try {
    return { parsed: JSON.parse(text), error: null };
  } catch (e) {
    return { parsed: null, error: (e as SyntaxError).message };
  }
}

/** Strip server-managed fields from an object. */
function stripServerFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const field of SERVER_FIELDS) {
    delete result[field];
  }
  return result;
}

export function AgentImportModal({ onClose }: AgentImportModalProps) {
  const { setAgents, setActiveAgentId } = useApp();
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Live parse feedback as the user types */
  const handleTextChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setError(null);
      return;
    }
    const { error: parseError } = tryParseJson(text);
    if (parseError) {
      setError(`Invalid JSON: ${parseError}`);
    } else {
      setError(null);
    }
  };

  /** Read a File and put its text content into the textarea */
  const loadFile = useCallback(async (file: File) => {
    const text = await file.text();
    setJsonText(text);
    if (!text.trim()) {
      setError(null);
      return;
    }
    const { error: parseError } = tryParseJson(text);
    if (parseError) {
      setError(`Invalid JSON: ${parseError}`);
    } else {
      setError(null);
    }
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = () => {
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      loadFile(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadFile(file);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleSubmit = async () => {
    const text = jsonText.trim();
    if (!text) {
      setError('Paste or drop a JSON file to import');
      return;
    }

    // Step 1: JSON must parse
    const { parsed, error: parseError } = tryParseJson(text);
    if (parseError) {
      setError(`Invalid JSON: ${parseError}`);
      return;
    }

    // Step 2–5: semantic validation
    const validationError = validateAgentPayload(parsed);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Strip server-managed fields before sending
    const cleaned = stripServerFields(parsed as Record<string, unknown>);

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleaned),
      });

      if (!res.ok) {
        let message: string;
        try {
          const data = await res.json();
          message = data?.error ?? `HTTP ${res.status}`;
        } catch {
          message = `HTTP ${res.status}`;
        }
        setError(message);
        setIsSubmitting(false);
        return;
      }

      const created = await res.json();
      setAgents(prev => [...prev, created]);
      setActiveAgentId(created.id);
      onClose();
    } catch (e) {
      setError((e as Error).message ?? 'Failed to import agent');
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal modal-wide" role="dialog" aria-labelledby="agentImportModalTitle">
        <h2 id="agentImportModalTitle">Import Agent</h2>

        {/* Drag-and-drop zone */}
        <div
          className={`import-drop-zone${isDraggingOver ? ' import-drop-zone--over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label="Drag and drop a JSON file here"
        >
          <span className="import-drop-zone-hint">Drag & drop a .json file here, or</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleBrowseClick}
          >
            Browse file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>

        {/* JSON textarea */}
        <div className="form-group" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="agentImportTextarea">
            Or paste JSON directly
          </label>
          <textarea
            id="agentImportTextarea"
            className="agent-import-textarea"
            rows={12}
            value={jsonText}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={'{\n  "name": "my-agent",\n  "prompt": "You are a helpful assistant..."\n}'}
            spellCheck={false}
          />
          {error && (
            <p className="import-error-text" role="alert">
              {error}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Importing…' : 'Import Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
