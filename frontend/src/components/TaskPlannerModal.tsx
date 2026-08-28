import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import type { OutputEntry, SessionActivity } from '../types';

interface TaskPlannerModalProps {
  onClose: () => void;
}

interface PlannerMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

interface ParsedTask {
  title: string;
  description?: string;
  priority: number;
  type: string;
  files?: string[];
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export function TaskPlannerModal({ onClose }: TaskPlannerModalProps) {
  const { currentTabId, setTasks } = useApp();
  const [messages, setMessages] = useState<PlannerMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'thinking' | 'error'>('connecting');
  const [parsedTask, setParsedTask] = useState<ParsedTask | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const partialMessageRef = useRef<string>('');
  const sessionIdRef = useRef<number | null>(null);

  // Keep ref in sync for WS handler
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Start the planner session
  useEffect(() => {
    let cancelled = false;
    (async () => {
      addMessage('system', 'Starting AI Task Planner...');
      try {
        const res = await apiFetch('/api/task-planner/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabId: currentTabId ? Number(currentTabId) : undefined }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        if (cancelled) return;
        const data = await res.json();
        setSessionId(data.sessionId);
        setReady(true);
        setStatus('ready');
        inputRef.current?.focus();
      } catch (e: any) {
        if (cancelled) return;
        addMessage('system', 'Failed to start: ' + e.message);
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [currentTabId]);

  // Listen for WebSocket output and activity
  useEffect(() => {
    const handleOutput = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId !== sessionIdRef.current) return;
      const entry: OutputEntry = detail.entry;
      if (!entry) return;
      if (entry.stream === 'system' && entry.text.startsWith('▶')) return;
      if (entry.stream === 'stderr') return;
      if (entry.stream === 'stdout') {
        partialMessageRef.current += (partialMessageRef.current ? '\n' : '') + entry.text;
        // Update the last message if it's a partial assistant message
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.text.startsWith('__PARTIAL__')) {
            return [...prev.slice(0, -1), { role: 'assistant', text: '__PARTIAL__' + partialMessageRef.current }];
          }
          return [...prev, { role: 'assistant', text: '__PARTIAL__' + partialMessageRef.current }];
        });
      }
    };

    const handleActivity = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId !== sessionIdRef.current) return;
      const activity: SessionActivity = detail.activity;
      if (!activity) return;
      if (activity.type === 'idle' || activity.type === 'completed') {
        // Flush accumulated message
        if (partialMessageRef.current.trim()) {
          const finalText = partialMessageRef.current.trim();
          setMessages(prev => {
            const filtered = prev.filter(m => !m.text.startsWith('__PARTIAL__'));
            return [...filtered, { role: 'assistant', text: finalText }];
          });
          tryParseTask(finalText);
          partialMessageRef.current = '';
        }
        setStatus('ready');
        setReady(true);
      } else if (activity.type === 'working' || activity.type === 'thinking') {
        setStatus('thinking');
      }
    };

    window.addEventListener('ws-session-output', handleOutput);
    window.addEventListener('ws-session-activity', handleActivity);
    return () => {
      window.removeEventListener('ws-session-output', handleOutput);
      window.removeEventListener('ws-session-activity', handleActivity);
    };
  }, []);

  // Auto-scroll messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const addMessage = (role: PlannerMessage['role'], text: string) => {
    setMessages(prev => [...prev, { role, text }]);
  };

  const tryParseTask = (text: string) => {
    // Look for ```json:task block
    const jsonMatch = text.match(/```json:task\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.title && parsed.priority && parsed.type) {
          setParsedTask(parsed);
          addMessage('system', '✅ Task ready to create! Click "Create Task" to add it to your board.');
          return;
        }
      } catch { /* not valid JSON */ }
    }
    // Fallback: standard ```json block
    const fallbackMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (fallbackMatch) {
      try {
        const parsed = JSON.parse(fallbackMatch[1]);
        if (parsed.title && parsed.priority && parsed.type) {
          setParsedTask(parsed);
          addMessage('system', '✅ Task ready to create! Click "Create Task" to add it to your board.');
        }
      } catch { /* not valid JSON */ }
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !sessionId || !ready) return;

    const attachedImage = imageData ? { data: imageData, mimeType: imageMimeType } : null;
    const attachedFileName = imageFileName;
    const displayText = attachedFileName ? `${text}\n📎 ${attachedFileName}` : text;

    addMessage('user', displayText);
    setInputText('');
    setReady(false);
    setStatus('thinking');
    clearAttachment();

    try {
      const body: Record<string, unknown> = { message: text };
      if (attachedImage) {
        body.image = attachedImage;
      }
      const res = await apiFetch(`/api/task-planner/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      addMessage('system', 'Error: ' + e.message);
      setStatus('ready');
      setReady(true);
    }
  };

  const handleCreateTask = async () => {
    if (!parsedTask || !sessionId) return;
    try {
      const body = {
        title: parsedTask.title,
        description: parsedTask.description || '',
        priority: Number(parsedTask.priority),
        type: parsedTask.type,
        files: parsedTask.files || [],
        tabIds: currentTabId ? [Number(currentTabId)] : [],
      };
      const res = await apiFetch(`/api/task-planner/${sessionId}/create-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const task = await res.json();
      setTasks(prev => {
        if (prev.find(t => t.id === task.id)) {
          return prev.map(t => t.id === task.id ? task : t);
        }
        return [...prev, task];
      });
      // Close — session cleanup handled by backend
      onClose();
    } catch (e: any) {
      addMessage('system', '❌ Failed to create task: ' + e.message);
    }
  };

  const handleClose = async () => {
    if (sessionId) {
      try {
        await apiFetch(`/api/task-planner/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore cleanup errors */ }
    }
    onClose();
  };

  const handleImageSelect = (file: File) => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      addMessage('system', `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP.`);
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      addMessage('system', `Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      setImageData(base64);
      setImageMimeType(file.type);
      setImageFileName(file.name);
    };
    reader.onerror = () => {
      addMessage('system', 'Failed to read image file.');
    };
    reader.readAsDataURL(file);
  };

  const clearAttachment = () => {
    setImageData(null);
    setImageMimeType(null);
    setImageFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const statusDotClass = status === 'ready' ? 'status-dot connected' : status === 'thinking' ? 'status-dot thinking' : 'status-dot';

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="modal modal-wide task-planner-modal" role="dialog" aria-labelledby="taskPlannerTitle">
        <div className="task-planner-header">
          <h2 id="taskPlannerTitle">AI Task Planner</h2>
          <div className="task-planner-status">
            <span className={statusDotClass}></span>
            <span className="status-text">
              {status === 'connecting' ? 'Connecting...' : status === 'ready' ? 'Ready' : status === 'thinking' ? 'Thinking...' : 'Error'}
            </span>
          </div>
        </div>
        <div className="task-planner-messages" ref={messagesRef}>
          {messages.map((msg, i) => {
            const isPartial = msg.text.startsWith('__PARTIAL__');
            const displayText = isPartial ? msg.text.slice('__PARTIAL__'.length) : msg.text;
            return (
              <div key={i} className={`planner-message ${msg.role}`}>
                {displayText}
              </div>
            );
          })}
        </div>
        <div className="task-planner-input-area">
          {imageFileName && (
            <div className="task-planner-attachment">
              <span className="task-planner-attachment-name">📎 {imageFileName}</span>
              <button type="button" className="task-planner-attachment-remove" onClick={clearAttachment} title="Remove attachment">✕</button>
            </div>
          )}
          <div className="task-planner-input-row">
            <button type="button" className="btn btn-secondary btn-sm" title="Attach image" onClick={() => fileInputRef.current?.click()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <textarea
              ref={inputRef}
              className="task-planner-input"
              placeholder="Describe the task you want to create..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={!ready}
              rows={1}
            />
            <button className="btn btn-primary btn-sm" disabled={!ready || !inputText.trim()} onClick={handleSend}>Send</button>
          </div>
          <input
            type="file"
            ref={fileInputRef}
            accept="image/jpeg,image/png,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageSelect(f); }}
          />
        </div>
        <div className="task-planner-actions">
          <button className="btn btn-secondary btn-sm" onClick={handleClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!parsedTask} onClick={handleCreateTask}>Create Task</button>
        </div>
      </div>
    </div>
  );
}
