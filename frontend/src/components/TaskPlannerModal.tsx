import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { renderPlannerMarkdown } from '../utils/renderPlannerMarkdown';
import { TaskCard } from './TaskCard';
import { TaskPlannerPreviewDetail } from './TaskPlannerPreviewDetail';
import type { Task, OutputEntry, SessionActivity } from '../types';

interface TaskPlannerModalProps {
  onClose: () => void;
  onSwitchToManual: () => void;
}

interface PlannerMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface ParsedTask {
  title: string;
  description?: string;
  priority: number;
  type: string;
  files?: string[];
  dependsOnBatchIndex?: number[];
  dependsOnTaskId?: number[];
  groupId?: string;
}

interface Attachment {
  data: string;
  mimeType: string;
  fileName: string;
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ATTACHMENTS = 3;

export function TaskPlannerModal({ onClose, onSwitchToManual }: TaskPlannerModalProps) {
  const { currentTabId, setTasks } = useApp();
  const [messages, setMessages] = useState<PlannerMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'thinking' | 'error'>('connecting');
  const [parsedTasks, setParsedTasks] = useState<ParsedTask[] | null>(null);
  const [previewDetailIndex, setPreviewDetailIndex] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const partialMessageRef = useRef<string>('');
  const sessionIdRef = useRef<number | null>(null);
  const cleanedUpSessionRef = useRef<Set<number>>(new Set());

  // Keep ref in sync for WS handler
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Keep attachments ref in sync for paste/file-input handlers
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Whenever the parsed batch is replaced (a fresh tryParseTask overwrite, or a
  // partial handleCreateTask failure that trims the array), close/reset the
  // detail panel so a stale index can't point past the new array's end.
  useEffect(() => {
    setPreviewDetailIndex(null);
  }, [parsedTasks]);

  // Start the planner session
  useEffect(() => {
    let cancelled = false;
    let createdSessionId: number | null = null;
    let adopted = false;

    // Shared cleanup so it can run both from the synchronous unmount path AND
    // from the async /start resolution path (see comment below on why both
    // call sites are needed under StrictMode's mount->cleanup->remount cycle).
    const cleanupOrphan = () => {
      if (createdSessionId !== null && (!adopted || sessionIdRef.current === createdSessionId)) {
        const idToDelete = createdSessionId;
        createdSessionId = null; // guard against a second call double-deleting
        if (!cleanedUpSessionRef.current.has(idToDelete)) {
          cleanedUpSessionRef.current.add(idToDelete);
          apiFetch(`/api/task-planner/${idToDelete}`, { method: 'DELETE' }).catch(() => { /* ignore cleanup errors */ });
        }
      }
      // Retract this run's own "Starting..." message if this run never got
      // adopted (e.g. StrictMode's synchronous mount->cleanup->remount in dev
      // cancels the first run before its /start call resolves) — otherwise a
      // real unmount-with-adopted-session (closing the modal normally) would
      // incorrectly erase the legitimate "Starting..." line too.
      if (startingMessageAdded && !adopted) {
        startingMessageAdded = false;
        setMessages(prev => {
          const idx = prev.findIndex(m => m === startingMessageRef);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
      }
    };

    let startingMessageAdded = false;
    let startingMessageRef: PlannerMessage | null = null;

    (async () => {
      startingMessageRef = { role: 'system', text: 'Starting AI Task Planner...' };
      startingMessageAdded = true;
      setMessages(prev => [...prev, startingMessageRef as PlannerMessage]);
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
        const data = await res.json();
        createdSessionId = data.sessionId;
        // IMPORTANT: under React StrictMode (dev), the effect's cleanup runs
        // synchronously immediately after mount — well before this `await`
        // resolves. At that point `createdSessionId` was still null, so the
        // synchronous cleanup below has nothing to delete yet. Without this
        // check, the backend session/kiro-cli process created by THIS
        // now-cancelled effect run would leak forever (two live sessions
        // instead of one). So: if we're already cancelled by the time the
        // response comes back, clean up right here instead of adopting it.
        if (cancelled) {
          cleanupOrphan();
          return;
        }
        adopted = true;
        setSessionId(data.sessionId);
        // Do NOT mark ready here — the HTTP 201 only means the session
        // record was created and startSession() was called; the actual
        // kiro-cli child process spawn (session.runner) happens
        // asynchronously afterwards (see session-manager.ts's runSession(),
        // which is fired-and-forgotten by startSession() rather than
        // awaited). Sending a message before that spawn completes hits
        // sendPrompt()'s `!session.runner` guard and fails with "Could not
        // send message — session may not be running", even though the UI
        // already said "Ready". The real readiness signal is the
        // 'idle'/'completed' WS session-activity event handled below, which
        // only fires once the runner exists and the initial prompt has been
        // sent — so just focus the input and leave status as 'connecting'
        // until that event arrives.
        inputRef.current?.focus();
      } catch (e: any) {
        if (cancelled) return;
        addMessage('system', 'Failed to start: ' + e.message);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      // If this instance's session was never adopted into component state (effect
      // re-run/unmount raced the /start request), or the component is unmounting
      // with a real sessionId still held, stop the orphaned backend session/kiro-cli
      // process instead of just abandoning it. handleClose() clears sessionId back to
      // null after its own DELETE, so this won't fire a duplicate delete for a session
      // already cleaned up via the Cancel button.
      cleanupOrphan();
    };
  }, [currentTabId]);

  // Listen for WebSocket output and activity
  useEffect(() => {
    /** Strip a successfully-parsed json:task fence from the message text. */
    const stripParsedFence = (text: string): string => {
      const fenceMatch = text.match(/```json:task\s*\n([\s\S]*?)\n```/) ?? text.match(/```json\s*\n([\s\S]*?)\n```/);
      if (!fenceMatch) return text;
      const parsed = parseTaskJsonLeniently(fenceMatch[1]);
      if (parsed && parsed.length > 0 && parsed.every(t => t.title && t.priority && t.type)) {
        return text.replace(fenceMatch[0], '').replace(/\n{3,}/g, '\n\n').trim();
      }
      return text;
    };

    const handleOutput = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId !== sessionIdRef.current) return;
      const entry: OutputEntry = detail.entry;
      if (!entry) return;
      if (entry.stream === 'system' && entry.text.startsWith('▶')) return;
      if (entry.stream === 'stderr') return;
      if (entry.stream === 'stdout') {
        partialMessageRef.current += (partialMessageRef.current ? '\n' : '') + entry.text;
        // Strip a completed json:task fence during streaming so raw JSON doesn't flash.
        const displayText = stripParsedFence(partialMessageRef.current);
        // Update the last message if it's a partial assistant message
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.text.startsWith('__PARTIAL__')) {
            return [...prev.slice(0, -1), { role: 'assistant', text: '__PARTIAL__' + displayText }];
          }
          return [...prev, { role: 'assistant', text: '__PARTIAL__' + displayText }];
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
          const displayText = tryParseTask(finalText);
          setMessages(prev => {
            const filtered = prev.filter(m => !m.text.startsWith('__PARTIAL__'));
            return [...filtered, { role: 'assistant', text: displayText }];
          });
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

  /**
   * Attempt to recover from the most common way the planner LLM's output
   * breaks a ```json:task block: long string values (title/description) get
   * line-wrapped by the markdown renderer or by the model itself, leaving
   * literal newline (and sometimes tab/CR) control characters embedded
   * inside what must be a single-line JSON string. JSON.parse rejects raw
   * control characters in strings outright ("Bad control character in
   * string literal"), even though the surrounding quote escaping (\") is
   * otherwise completely correct.
   *
   * Worse, the wrap can land *inside* an escape sequence itself — e.g. a
   * `\"` meant to close a quoted phrase gets split into `\` <newline> `"`,
   * which isn't a valid JSON escape (`\<newline>`) and would otherwise trip
   * up a naive scanner (it would consume the newline as "the escaped
   * character" and copy it through verbatim). So repair happens in two
   * passes:
   *   1. Collapse any backslash immediately followed by raw newline/CR back
   *      together (`\` + line-break(s) -> `\`), rejoining escape sequences
   *      that got split across a wrap.
   *   2. String-aware scan: track whether we're inside a JSON string
   *      (respecting escape sequences, which now consume their real target
   *      character again) and replace any remaining raw newline/CR/tab
   *      found *inside* a string with its proper \n/\r/\t escape.
   * Characters outside strings (structural whitespace between tokens) are
   * left untouched throughout.
   *
   * A wrap can also land *inside a key name* rather than a value — e.g.
   * `"title\n": ...` or `{"\ntitle": ...}`. That still parses as valid JSON
   * after the repair above, but produces a key literally named "title\n" or
   * "\ntitle" instead of "title", so `parsed.title` reads as undefined even
   * though a human (and the AI itself, re-reading its own output) would say
   * the field is "obviously" present. This previously surfaced as an
   * inconsistent "missing required fields" false-positive that even a
   * verbatim resend didn't reliably fix, since the wrap position — and
   * therefore whether it happened to land inside a key vs. a value — shifts
   * with the surrounding text on each resend. Fix: normalize every key by
   * stripping leading/trailing whitespace (including escaped \n/\r/\t left
   * by the repair pass) after parsing, since no key in this schema is ever
   * legitimately whitespace-padded. The same normalization is also applied
   * to string values, since a wrap can land right after a value's opening
   * quote (e.g. `"type": "\nbug"` → value is "\nbug" instead of "bug") and
   * no field in this schema is ever legitimately whitespace-padded at its
   * edges (internal whitespace in multi-line descriptions is preserved —
   * only leading/trailing edges are trimmed).
   */
  const parseTaskJsonLeniently = (raw: string): ParsedTask[] | null => {
    const normalizeKeys = (obj: unknown): unknown => {
      if (Array.isArray(obj)) return obj.map(normalizeKeys);
      if (obj && typeof obj === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k.replace(/^(?:\s|\\[nrt])+|(?:\s|\\[nrt])+$/g, '')] = normalizeKeys(v);
        }
        return out;
      }
      if (typeof obj === 'string') {
        return obj.replace(/^(?:\s|\\[nrt])+|(?:\s|\\[nrt])+$/g, '');
      }
      return obj;
    };

    /** Normalize parsed JSON to a ParsedTask array. Tolerates a single object (not wrapped in array). */
    const toArray = (parsed: unknown): ParsedTask[] | null => {
      const normalized = normalizeKeys(parsed);
      if (Array.isArray(normalized)) return normalized as ParsedTask[];
      if (normalized && typeof normalized === 'object') return [normalized as ParsedTask];
      return null;
    };

    try {
      return toArray(JSON.parse(raw));
    } catch {
      // Fall through to recovery below.
    }
    try {
      const rejoined = raw.replace(/\\[\r\n]+/g, '\\');

      let repaired = '';
      let inString = false;
      for (let i = 0; i < rejoined.length; i++) {
        const ch = rejoined[i];
        if (ch === '\\' && inString) {
          repaired += ch;
          if (i + 1 < rejoined.length) {
            repaired += rejoined[i + 1];
            i++;
          }
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          repaired += ch;
          continue;
        }
        if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
          repaired += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
          continue;
        }
        repaired += ch;
      }
      return toArray(JSON.parse(repaired));
    } catch {
      return null;
    }
  };

  const tryParseTask = (text: string): string => {
    // Look for ```json:task block first, falling back to a plain ```json block.
    const jsonMatch = text.match(/```json:task\s*\n([\s\S]*?)\n```/) ?? text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!jsonMatch) return text;

    const raw = jsonMatch[1];
    const parsed = parseTaskJsonLeniently(raw);
    if (parsed && parsed.length > 0) {
      // Validate every element has required fields
      const allValid = parsed.every(t => t.title && t.priority && t.type);
      if (allValid) {
        setParsedTasks(parsed);
        const taskWord = parsed.length > 1 ? 'Tasks' : 'Task';
        addMessage('system', `✅ ${parsed.length > 1 ? `${parsed.length} tasks` : 'Task'} ready to create! Click "Create ${taskWord}" to add ${parsed.length > 1 ? 'them' : 'it'} to your board.`);
        // Strip the matched fenced block from the display text
        const stripped = text.replace(jsonMatch[0], '').replace(/\n{3,}/g, '\n\n').trim();
        return stripped;
      } else {
        addMessage('system', '⚠️ The AI produced a task block missing required fields (title/priority/type) — ask it to resend the task.');
      }
      return text;
    }

    // Both the strict parse and the lenient recovery pass failed. Surface this
    // instead of leaving "Create Task" silently disabled with no explanation.
    addMessage('system', '⚠️ Could not parse the task block above (invalid JSON) — ask the AI to resend it as a single-line JSON value (no line-wrapped strings).');
    return text;
  };

  /** Validate and add a single file as an attachment. */
  const addAttachment = useCallback((file: File) => {
    // Validate before reading
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      addMessage('system', `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP.`);
      return;
    }

    if (file.size > MAX_IMAGE_SIZE) {
      addMessage('system', `Image too large: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds the 10MB limit.`);
      return;
    }

    // Read the file asynchronously, then update attachments
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      setAttachments(current => {
        if (current.length >= MAX_ATTACHMENTS) {
          // Silently reject — callers (paste handler, file-picker) show their
          // own single cap-exceeded message for the entire batch, so we avoid
          // firing a duplicate per rejected file.
          return current;
        }
        return [...current, { data: base64, mimeType: file.type, fileName: file.name }];
      });
    };
    reader.onerror = () => {
      addMessage('system', 'Failed to read image file.');
    };
    reader.readAsDataURL(file);
  }, []);

  // Paste event listener — attach image(s) from clipboard when modal is open
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && ALLOWED_MIME_TYPES.includes(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length === 0) return;

      // Prevent the default paste behavior for image content
      e.preventDefault();

      // Pre-calculate remaining slots to avoid duplicate cap messages
      const remaining = MAX_ATTACHMENTS - attachmentsRef.current.length;
      const toAdd = imageFiles.slice(0, remaining);
      const dropped = imageFiles.length - toAdd.length;

      for (const file of toAdd) {
        addAttachment(file);
      }

      if (dropped > 0) {
        addMessage('system', `Maximum of ${MAX_ATTACHMENTS} images per message.`);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [addAttachment]);

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const clearAttachments = () => {
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !sessionId || !ready) return;

    const currentAttachments = [...attachments];
    const fileLines = currentAttachments.map(a => `📎 ${a.fileName}`).join('\n');
    const displayText = fileLines ? `${text}\n${fileLines}` : text;

    addMessage('user', displayText);
    setInputText('');
    setReady(false);
    setStatus('thinking');
    clearAttachments();

    try {
      const body: Record<string, unknown> = { message: text };
      if (currentAttachments.length > 0) {
        body.images = currentAttachments.map(a => ({ data: a.data, mimeType: a.mimeType }));
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
    if (!parsedTasks || parsedTasks.length === 0 || !sessionId) return;
    try {
      const body = {
        tasks: parsedTasks.map(t => ({
          title: t.title,
          description: t.description || '',
          priority: Number(t.priority),
          type: t.type,
          files: t.files || [],
          tabIds: currentTabId ? [Number(currentTabId)] : [],
          dependsOnBatchIndex: t.dependsOnBatchIndex,
          dependsOnTaskId: t.dependsOnTaskId,
          groupId: t.groupId,
        })),
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
      const result = await res.json();
      const { created, failed } = result as {
        created: Array<{ id: number; [key: string]: unknown }>;
        failed: Array<{ task: { title: string; [key: string]: unknown }; error: string }>;
      };

      // Add all successfully created tasks to state
      if (created && created.length > 0) {
        setTasks(prev => {
          let updated = [...prev];
          for (const task of created) {
            const existing = updated.findIndex(t => t.id === task.id);
            if (existing >= 0) {
              updated[existing] = task as any;
            } else {
              updated.push(task as any);
            }
          }
          return updated;
        });
      }

      // Handle partial failure
      if (failed && failed.length > 0) {
        // Update parsedTasks to only contain the failed tasks, so a retry
        // doesn't re-send the already-created ones (which would create duplicates).
        const failedTasks: typeof parsedTasks = failed.map((f: any) => ({
          title: f.task.title,
          description: f.task.description,
          priority: f.task.priority,
          type: f.task.type,
          files: f.task.files,
          // Drop dependsOnBatchIndex — indices are stale after the array changed
          dependsOnTaskId: f.task.dependsOnTaskId,
          groupId: f.task.groupId,
        }));
        setParsedTasks(failedTasks);
        for (const f of failed) {
          addMessage('system', `❌ "${f.task.title}" failed to create: ${f.error}`);
        }
        // Don't close — let user see failures
      } else {
        // Full success — close modal
        onClose();
      }
    } catch (e: any) {
      addMessage('system', '❌ Failed to create task: ' + e.message);
    }
  };

  const handleClose = async () => {
    if (sessionId && !cleanedUpSessionRef.current.has(sessionId)) {
      cleanedUpSessionRef.current.add(sessionId);
      try {
        await apiFetch(`/api/task-planner/${sessionId}`, { method: 'DELETE' });
      } catch { /* ignore cleanup errors */ }
      setSessionId(null);
    }
    onClose();
  };

  const handleSwitchToManual = async () => {
    await handleClose();
    onSwitchToManual();
  };

  /** Handle file picker selection — supports multiple files. */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    // Pre-calculate remaining slots to avoid duplicate cap messages
    const remaining = MAX_ATTACHMENTS - attachmentsRef.current.length;
    const dropped = files.length - remaining;

    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      addAttachment(files[i]);
    }
    if (dropped > 0) {
      addMessage('system', `Maximum of ${MAX_ATTACHMENTS} images per message.`);
    }
    // Reset the input so the same file(s) can be re-selected
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
            if (msg.role === 'user') {
              return (
                <div key={i} className={`planner-message ${msg.role}`}>
                  {displayText}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`planner-message ${msg.role}`}
                dangerouslySetInnerHTML={{ __html: renderPlannerMarkdown(displayText) }}
              />
            );
          })}
        </div>
        <div className="task-planner-input-area">
          {attachments.length > 0 && (
            <div className="task-planner-attachments">
              {attachments.map((att, idx) => (
                <div key={idx} className="task-planner-attachment">
                  <span className="attachment-filename">{att.fileName}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() => removeAttachment(idx)}
                    title="Remove attachment"
                  >✕</button>
                </div>
              ))}
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
              rows={1}
            />
            <button className="btn btn-primary btn-sm" disabled={!ready || !inputText.trim()} onClick={handleSend}>Send</button>
          </div>
          <input
            type="file"
            ref={fileInputRef}
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
        </div>
        {parsedTasks && parsedTasks.length > 0 && (
          <div className="task-planner-preview">
            {parsedTasks.map((pt, idx) => {
              const previewTask: Task = {
                id: 0,
                title: pt.title,
                description: pt.description,
                type: pt.type as Task['type'],
                priority: Number(pt.priority),
                state: 'todo',
                origin: 'ai',
              };
              return (
                <TaskCard key={idx} task={previewTask} onClick={() => setPreviewDetailIndex(idx)} disableInteraction={true} />
              );
            })}
          </div>
        )}
        <div className="task-planner-actions">
          <button className="btn btn-secondary btn-sm" onClick={handleClose}>Cancel</button>
          <button className="btn btn-secondary btn-sm" onClick={handleSwitchToManual}>Create manually instead</button>
          <button className="btn btn-primary btn-sm" disabled={!parsedTasks} onClick={handleCreateTask}>{parsedTasks && parsedTasks.length > 1 ? 'Create Tasks' : 'Create Task'}</button>
        </div>
        {previewDetailIndex !== null && parsedTasks && (
          <TaskPlannerPreviewDetail
            tasks={parsedTasks}
            index={previewDetailIndex}
            onIndexChange={setPreviewDetailIndex}
            onClose={() => setPreviewDetailIndex(null)}
          />
        )}
      </div>
    </div>
  );
}
