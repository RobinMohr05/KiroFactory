import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { Tab, Task, Session, Agent, AgentError, OutputEntry, SessionActivity, User, ViewTab, UiViewMode, WsMessage, Flock } from '../types';
import { apiFetch } from '../utils/api';

interface AppState {
  user: User | null;
  tabs: Tab[];
  currentTabId: number | null;
  tasks: Task[];
  sessions: Session[];
  agents: Agent[];
  errors: AgentError[];
  flocks: Flock[];
  connected: boolean;
  activeSessionId: number | null;
  activeAgentId: number | null;
  activeView: ViewTab;
  currentSort: 'priority' | 'updated' | 'created';
  highlightedTaskId: number | null;
}

interface AppContextValue extends AppState {
  setCurrentTabId: (id: number | null) => void;
  setActiveSessionId: (id: number | null) => void;
  setActiveAgentId: (id: number | null) => void;
  setActiveView: (view: ViewTab) => void;
  setCurrentSort: (sort: 'priority' | 'updated' | 'created') => void;
  setHighlightedTaskId: (id: number | null) => void;
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  setErrors: React.Dispatch<React.SetStateAction<AgentError[]>>;
  setFlocks: React.Dispatch<React.SetStateAction<Flock[]>>;
  fetchTabs: () => Promise<void>;
  fetchTabTasks: (tabId: number) => Promise<void>;
  fetchSessions: () => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchErrors: () => Promise<void>;
  fetchFlocks: () => Promise<void>;
  logout: () => Promise<void>;
  pendingOps: React.MutableRefObject<Set<string>>;
  /**
   * Switch the user's top-level UI view mode. Persists to the backend first;
   * only updates local `user` state (which App.tsx gates layout on) if the
   * API call succeeds. Throws on failure so callers (the confirmation UI)
   * can show an error instead of silently flipping the view.
   */
  setUiViewMode: (mode: UiViewMode) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [errors, setErrors] = useState<AgentError[]>([]);
  const [flocks, setFlocks] = useState<Flock[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const [currentSort, setCurrentSort] = useState<'priority' | 'updated' | 'created'>('priority');
  const [activeView, setActiveView] = useState<ViewTab>('boards');
  const [highlightedTaskId, setHighlightedTaskId] = useState<number | null>(null);

  const pendingOps = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsHasConnectedOnce = useRef(false);
  const currentTabIdRef = useRef<number | null>(null);

  // --- Auth check ---
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (res.status === 401) {
          const currentPath = window.location.pathname + window.location.search;
          const returnTo = currentPath !== '/' && currentPath !== '/login' ? `?returnTo=${encodeURIComponent(currentPath)}` : '';
          window.location.href = `/login.html${returnTo}`;
          return;
        }
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        }
      } catch {
        // Network error — allow through
      }
    })();
  }, []);

  // --- Data fetching ---
  const fetchTabs = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tabs');
      if (!res.ok) return;
      const data: Tab[] = await res.json();
      setTabs(data);
      setCurrentTabId(prev => prev === null && data.length > 0 ? data[0].id : prev);
    } catch (e) {
      console.error('Failed to fetch tabs:', e);
    }
  }, []);

  const fetchTabTasks = useCallback(async (tabId: number) => {
    try {
      const res = await apiFetch(`/api/tabs/${tabId}`);
      if (!res.ok) return;
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (e) {
      console.error('Failed to fetch tab tasks:', e);
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/sessions');
      if (!res.ok) return;
      const data: Session[] = await res.json();
      setSessions(data);
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch('/api/agents');
      if (!res.ok) return;
      const data: Agent[] = await res.json();
      setAgents(data);
    } catch (e) {
      console.error('Failed to fetch agents:', e);
    }
  }, []);

  const fetchErrors = useCallback(async () => {
    try {
      const res = await apiFetch('/api/errors');
      if (!res.ok) return;
      const data: AgentError[] = await res.json();
      setErrors(data);
    } catch (e) {
      console.error('Failed to fetch errors:', e);
    }
  }, []);

  const fetchFlocks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/flocks');
      if (!res.ok) return;
      const data: Flock[] = await res.json();
      setFlocks(data);
    } catch (e) {
      console.error('Failed to fetch flocks:', e);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }
    window.location.href = '/login.html';
  }, []);

  const setUiViewMode = useCallback(async (mode: UiViewMode) => {
    const res = await apiFetch('/api/auth/me/view-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiViewMode: mode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to switch view mode (HTTP ${res.status})`);
    }
    const data = await res.json();
    setUser(data.user);
  }, []);

  // --- WebSocket ---
  const handleWsMessage = useCallback((message: WsMessage) => {
    const dedupKey = (type: string, id: number | undefined) => id ? `${type}-${id}` : null;

    switch (message.type) {
      case 'task-created': {
        const key = dedupKey('task-created', message.task?.id);
        if (key && pendingOps.current.has(key)) { pendingOps.current.delete(key); return; }
        setTasks(prev => {
          if (prev.find(t => t.id === message.task.id)) return prev;
          const belongsToTab = message.task.tabs?.some((b: { id: number }) => b.id === currentTabIdRef.current);
          if (!belongsToTab) return prev;
          return [...prev, message.task];
        });
        break;
      }
      case 'task-updated': {
        const key = dedupKey('task-updated', message.task?.id);
        if (key && pendingOps.current.has(key)) { pendingOps.current.delete(key); return; }
        setTasks(prev => {
          const idx = prev.findIndex(t => t.id === message.task.id);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = message.task;
            return next;
          }
          // Only add if it belongs to the current tab
          const belongsToTab = message.task.tabs?.some((b: { id: number }) => b.id === currentTabIdRef.current);
          if (!belongsToTab) return prev;
          return [...prev, message.task];
        });
        break;
      }
      case 'task-deleted': {
        const key = dedupKey('task-deleted', message.taskId);
        if (key && pendingOps.current.has(key)) { pendingOps.current.delete(key); return; }
        setTasks(prev => prev.filter(t => t.id !== message.taskId));
        break;
      }
      case 'tab-created': {
        setTabs(prev => {
          if (prev.find(b => b.id === message.tab.id)) return prev;
          return [...prev, message.tab];
        });
        break;
      }
      case 'tab-updated': {
        setTabs(prev => prev.map(b => b.id === message.tab.id ? message.tab : b));
        break;
      }
      case 'tab-deleted': {
        setTabs(prev => prev.filter(b => b.id !== message.tabId));
        break;
      }
      case 'tabs-reordered': {
        if (pendingOps.current.has('tabs-reordered')) {
          pendingOps.current.delete('tabs-reordered');
        } else if (message.tabs) {
          setTabs(message.tabs);
        }
        break;
      }
      case 'session-created': {
        setSessions(prev => {
          if (prev.find(s => s.id === message.session.id)) return prev;
          return [...prev, message.session];
        });
        break;
      }
      case 'session-updated': {
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === message.session.id);
          if (idx !== -1) {
            const next = [...prev];
            const existing = next[idx];
            const updated = { ...existing, ...message.session };
            // When totalCreditsUsed resets to 0 (session restarted), also reset turnCount
            if (message.session.totalCreditsUsed === 0 && existing.totalCreditsUsed !== 0) {
              updated.turnCount = 0;
              updated.currentTaskTitle = undefined;
              updated.currentTaskId = undefined;
            }
            // Clear currentTaskId and currentTaskTitle when currentTaskId is cleared
            if (!message.session.currentTaskId && existing.currentTaskId) {
              updated.currentTaskId = undefined;
              updated.currentTaskTitle = undefined;
            }
            next[idx] = updated;
            return next;
          }
          return [...prev, message.session];
        });
        window.dispatchEvent(new CustomEvent('ws-session-updated', { detail: message }));
        break;
      }
      case 'session-deleted': {
        setSessions(prev => prev.filter(s => s.id !== message.sessionId));
        break;
      }
      case 'sessions-reordered': {
        if (pendingOps.current.has('sessions-reordered')) {
          pendingOps.current.delete('sessions-reordered');
        } else if (message.sessions) {
          setSessions(prev => {
            const updated = [...prev];
            for (const s of message.sessions) {
              const idx = updated.findIndex(x => x.id === s.id);
              if (idx !== -1) updated[idx] = { ...updated[idx], ...s };
              else updated.push(s);
            }
            return updated;
          });
        }
        break;
      }
      case 'session-output': {
        // Handled by SessionOutput component via a separate event emitter
        window.dispatchEvent(new CustomEvent('ws-session-output', { detail: message }));
        break;
      }
      case 'session-activity': {
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === message.sessionId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], currentActivity: message.activity };
          return next;
        });
        window.dispatchEvent(new CustomEvent('ws-session-activity', { detail: message }));
        break;
      }
      case 'session-turn-start': {
        // Update session's turnCount and currentTaskTitle from turn-start events
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === message.sessionId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            turnCount: (next[idx].turnCount ?? 0) + 1,
            ...(message.taskTitle ? { currentTaskTitle: message.taskTitle } : {}),
            ...(message.taskId ? { currentTaskId: message.taskId } : {}),
          };
          return next;
        });
        window.dispatchEvent(new CustomEvent('ws-session-turn-start', { detail: message }));
        break;
      }
      case 'session-turn-end': {
        window.dispatchEvent(new CustomEvent('ws-session-turn-end', { detail: message }));
        break;
      }
      case 'session-tool-call': {
        window.dispatchEvent(new CustomEvent('ws-session-tool-call', { detail: message }));
        break;
      }
      case 'session-tool-call-update': {
        window.dispatchEvent(new CustomEvent('ws-session-tool-call-update', { detail: message }));
        break;
      }
      case 'error-created': {
        setErrors(prev => {
          if (prev.find(e => e.id === message.error.id)) return prev;
          return [message.error, ...prev];
        });
        break;
      }
      case 'error-dismissed': {
        setErrors(prev => prev.filter(e => e.id !== message.errorId));
        break;
      }
      case 'errors-cleared': {
        setErrors([]);
        break;
      }
      case 'flock-created': {
        setFlocks(prev => {
          if (prev.find(f => f.id === message.flock.id)) return prev;
          return [...prev, message.flock];
        });
        break;
      }
      case 'flock-updated': {
        setFlocks(prev => {
          const idx = prev.findIndex(f => f.id === message.flock.id);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...message.flock };
            return next;
          }
          return [...prev, message.flock];
        });
        break;
      }
      case 'flock-deleted': {
        setFlocks(prev => prev.filter(f => f.id !== message.flockId));
        break;
      }
      case 'wsl-diagnostic-line': {
        // No app-wide state to update — the "WSL/Docker Logs" sub-tab listens
        // for this directly via the custom event, matching the ws-session-*
        // pattern used for session output/activity elsewhere in this file.
        window.dispatchEvent(new CustomEvent('ws-wsl-diagnostic-line', { detail: message }));
        break;
      }
      case 'connected':
        break;
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    // Guard against React 18 StrictMode's dev-only double-invoke of this
    // effect: mount -> cleanup -> mount happens synchronously, but
    // WebSocket.close() is asynchronous, so the first socket can still be
    // OPEN (and still registered in the server's per-user client set) when
    // the second socket connects. Without this guard, every broadcast is
    // briefly delivered twice to the same tab (visible as duplicated lines
    // in the session output log). Tagging each socket and checking it's
    // still the "current" one before acting on open/message/close ensures a
    // superseded socket is inert — it gets forced closed and never invokes
    // handleWsMessage — even during that overlap window.
    const isCurrent = () => wsRef.current === ws;
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      if (!isCurrent()) {
        ws.close();
        return;
      }
      setConnected(true);
      wsHasConnectedOnce.current = true;
    });

    ws.addEventListener('close', (event) => {
      if (!isCurrent()) return;
      setConnected(false);
      wsRef.current = null;
      if (event.code === 4001) {
        window.location.href = '/login.html';
        return;
      }
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectWebSocket();
        }, 3000);
      }
    });

    ws.addEventListener('error', () => {
      ws.close();
    });

    ws.addEventListener('message', (event) => {
      if (!isCurrent()) return;
      try {
        const message = JSON.parse(event.data) as WsMessage;
        handleWsMessage(message);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    });
  }, [handleWsMessage]);

  // --- Initialize ---
  useEffect(() => {
    connectWebSocket();
    fetchTabs();
    fetchSessions();
    fetchAgents();
    fetchErrors();
    fetchFlocks();

    return () => {
      // Detach immediately so a stale socket (still closing async) never
      // gets treated as current — see the isCurrent() guard in
      // connectWebSocket for why this matters under StrictMode.
      const staleWs = wsRef.current;
      wsRef.current = null;
      if (staleWs) staleWs.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectWebSocket, fetchTabs, fetchSessions, fetchAgents, fetchErrors, fetchFlocks]);

  // Polling fallback: refetch tasks every 3s while WebSocket is disconnected
  useEffect(() => {
    if (connected) return;
    const interval = setInterval(() => {
      if (currentTabId) fetchTabTasks(currentTabId);
    }, 3000);
    return () => clearInterval(interval);
  }, [connected, currentTabId, fetchTabTasks]);

  // Reconnect refetch: when WS reconnects (not initial connect), refetch current data
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (connected && prevConnectedRef.current === false && wsHasConnectedOnce.current) {
      // Reconnected after a disconnect — refetch to catch up on missed messages
      if (currentTabId) fetchTabTasks(currentTabId);
      fetchSessions();
      fetchErrors();
    }
    prevConnectedRef.current = connected;
  }, [connected, currentTabId, fetchTabTasks, fetchSessions, fetchErrors]);

  // Reconciliation timer: refetch all data every 20 minutes as a safety net
  useEffect(() => {
    const interval = setInterval(() => {
      fetchTabs();
      if (currentTabId) fetchTabTasks(currentTabId);
      fetchSessions();
      fetchErrors();
    }, 20 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchTabs, currentTabId, fetchTabTasks, fetchSessions, fetchErrors]);

  // Fetch tasks when tab changes
  useEffect(() => {
    if (currentTabId) {
      fetchTabTasks(currentTabId);
    }
  }, [currentTabId, fetchTabTasks]);

  // Keep currentTabIdRef in sync for WS message filtering
  useEffect(() => {
    currentTabIdRef.current = currentTabId;
  }, [currentTabId]);

  const value: AppContextValue = {
    user,
    tabs,
    currentTabId,
    tasks,
    sessions,
    agents,
    errors,
    flocks,
    connected,
    activeSessionId,
    activeAgentId,
    activeView,
    currentSort,
    highlightedTaskId,
    setCurrentTabId,
    setActiveSessionId,
    setActiveAgentId,
    setActiveView,
    setCurrentSort,
    setHighlightedTaskId,
    setTabs,
    setTasks,
    setSessions,
    setAgents,
    setErrors,
    setFlocks,
    fetchTabs,
    fetchTabTasks,
    fetchSessions,
    fetchAgents,
    fetchErrors,
    fetchFlocks,
    logout,
    pendingOps,
    setUiViewMode,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
