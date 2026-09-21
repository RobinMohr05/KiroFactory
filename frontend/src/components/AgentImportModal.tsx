import { useState, useRef, useCallback } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

interface AgentImportModalProps {
  onClose: () => void;
}

const SERVER_FIELDS = ['id', 'userId', 'createdAt', 'updatedAt', 'tabIds'] as const;

function validateAgentJson(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Expected a JSON object';
  }
  const obj = parsed as Record<string, unknown>;

  // 1. name must be a non-empty string matching /^[a-zA-Z0-9_-]+$/
  if (!('name' in obj) || typeof obj.name !== 'string' || obj.name.trim() === '') {
    return 'Missing required field: name';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(obj.name)) {
    return 'name must only contain letters, numbers, dashes, and underscores';
  }

  // 2. prompt must be a non-empty string
  if (!('prompt' in obj) || typeof obj.prompt !== 'string' || obj.prompt.trim() === '') {
    return 'Missing required field: prompt';
  }

  // 3. kind, if present, must be 'editor' or 'inspector'
  if ('kind' in obj && obj.kind !== 'editor' && obj.kind !== 'inspector') {
    return "kind must be 'editor' or 'inspector'";
  }

  // 4. mcpServers, if present, must be an array with valid items
  if ('mcpServers' in obj) {
    if (!Array.isArray(obj.mcpServers)) {
      return 'mcpServers must be an array';
    }
    for (let i = 0; i < obj.mcpServers.length; i++) {
      const server = obj.mcpServers[i];
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
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFileContent = useCallback((file: File) => {
    if (!file.name.endsWith('.json')) {
      setError('Please select a .json file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setJsonText(text);
      // Run live parse feedback
      try {
        JSON.parse(text);
        setError(null);
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFileContent(file);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFileContent(file);
    // Reset input so same file can be picked again
    e.target.value = '';
  };

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setJsonText(text);
    // Live parse feedback
    if (text.trim() === '') {
      setError(null);
      return;
    }
    try {
      JSON.parse(text);
      setError(null);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;

    // Parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }

    // Validate semantics
    const validationError = validateAgentJson(parsed);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Strip server-managed fields
    const cleaned = stripServerFields(parsed as Record<string, unknown>);

    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleaned),
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body.error) errMsg = body.error;
        } catch {
          // ignore parse error
        }
        setError(errMsg);
        return;
      }
      const created = await res.json();
      setAgents(prev => prev.find(a => a.id === created.id) ? prev : [...prev, created]);
      setActiveAgentId(created.id);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to import agent');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-labelledby="agentImportModalTitle">
        <h2 id="agentImportModalTitle">Import Agent</h2>

        <div
          className={`agent-import-drop-zone${isDragOver ? ' drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label="Drop zone for JSON file"
        >
          <span className="agent-import-drop-label">Drop a <code>.json</code> file here, or</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Browse file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            aria-label="Browse JSON file"
          />
        </div>

        <div className="form-group" style={{ marginTop: '1rem' }}>
          <label htmlFor="agentImportTextarea">Or paste JSON directly:</label>
          <textarea
            id="agentImportTextarea"
            rows={10}
            placeholder={'{\n  "name": "my-agent",\n  "prompt": "You are..."\n}'}
            value={jsonText}
            onChange={handleTextChange}
            style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
          />
        </div>

        {error && (
          <div className="agent-import-error" role="alert">
            {error}
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !jsonText.trim()}
          >
            {isSubmitting ? 'Importing…' : 'Import Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
