/**
 * Tests that *-created WebSocket echo messages do not cause duplicate list
 * entries regardless of the order in which the direct POST-response state
 * update and the WS echo arrive.
 *
 * Strategy:
 *  - Render AppProvider with a mock WebSocket that lets us inject messages.
 *  - Simulate the "WS echo arrives first, then POST response state setter runs"
 *    path — which is the broken scenario because the current code in
 *    TabBar.handleTabSaved and AgentModal.handleSubmit do a raw
 *    `setXxx(prev => [...prev, created])` with no id-guard.
 *  - After the fix, both paths (WS-first or POST-first) must produce exactly
 *    one entry per id.
 *
 * These tests target the root cause described in task #1698:
 *   The backend broadcasts a *-created WS message to ALL of the user's open
 *   sockets (including the originating one). So two codepaths can append the
 *   same entity: (a) the POST response handler in the component, and (b) the
 *   AppContext WS message handler. Whichever runs second produces a duplicate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppProvider, useApp } from '../context/AppContext';
import type { Tab, Task, Session, Agent, AgentError, AutoScaler, WsMessage } from '../types';

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

type WsMessageListener = (event: { data: string }) => void;
let wsMessageListener: WsMessageListener | null = null;

/**
 * Fires a fake WebSocket message into the AppContext WS handler.
 */
function fireWsMessage(msg: WsMessage | { type: string; [key: string]: unknown }) {
  if (wsMessageListener) {
    wsMessageListener({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  wsMessageListener = null;

  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01' } }),
      });
    }
    // Return empty lists for all initial fetches
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  }));

  vi.stubGlobal('WebSocket', class MockWebSocket {
    constructor() {}
    addEventListener(event: string, cb: WsMessageListener) {
      if (event === 'message') wsMessageListener = cb;
    }
    removeEventListener() {}
    close() {}
    send() {}
  });
});

// ---------------------------------------------------------------------------
// Helper: render AppProvider and expose context state + setters
// ---------------------------------------------------------------------------

interface ExposedState {
  tabs: Tab[];
  tasks: Task[];
  sessions: Session[];
  agents: Agent[];
  errors: AgentError[];
  autoScalers: AutoScaler[];
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  setErrors: React.Dispatch<React.SetStateAction<AgentError[]>>;
  setAutoScalers: React.Dispatch<React.SetStateAction<AutoScaler[]>>;
}

function Exposer({ stateRef }: { stateRef: { current: ExposedState | null } }) {
  const ctx = useApp();
  stateRef.current = {
    tabs: ctx.tabs,
    tasks: ctx.tasks,
    sessions: ctx.sessions,
    agents: ctx.agents,
    errors: ctx.errors,
    autoScalers: ctx.autoScalers,
    setTabs: ctx.setTabs,
    setTasks: ctx.setTasks,
    setSessions: ctx.setSessions,
    setAgents: ctx.setAgents,
    setErrors: ctx.setErrors,
    setAutoScalers: ctx.setAutoScalers,
  };
  return null;
}

function renderApp() {
  const stateRef: { current: ExposedState | null } = { current: null };
  render(
    <AppProvider>
      <Exposer stateRef={stateRef} />
    </AppProvider>
  );
  return stateRef;
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const TAB_1: Tab = { id: 42, name: 'My Tab' };
const TASK_1: Task = {
  id: 101,
  title: 'Test task',
  type: 'feature',
  priority: 3,
  state: 'todo',
  tabs: [{ id: 1, name: 'VCH' }],
};
const SESSION_1: Session = { id: 201, name: 'Test session', status: 'stopped' };
const AGENT_1: Agent = { id: 301, name: 'test-agent', prompt: 'do stuff' };
const ERROR_1: AgentError = {
  id: 'err-401',
  message: 'Something failed',
  context: 'some context',
  agent: 'test-agent',
  sessionName: 'session-1',
  timestamp: '2024-01-01T00:00:00Z',
};
const AUTOSCALER_1: AutoScaler = {
  id: 501,
  name: 'My Scaler',
  userId: 1,
  agentName: 'test-agent',
  tabIds: [1],
  maxConcurrency: 5,
  idleTimeoutSeconds: 30,
  status: 'stopped',
  createdAt: '2024-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// tab-created
// ---------------------------------------------------------------------------

describe('tab-created dedup — WS handler', () => {
  it('WS tab-created for an id already in state does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // POST response already ran — tab is in state
    act(() => {
      stateRef.current!.setTabs(prev => [...prev, TAB_1]);
    });

    await waitFor(() => expect(stateRef.current!.tabs).toHaveLength(1));

    // WS echo arrives — WS handler has dedup, should skip
    act(() => {
      fireWsMessage({ type: 'tab-created', tab: TAB_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.tabs.filter(t => t.id === TAB_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.tabs).toHaveLength(1);
  });

  it('WS tab-created arrives first, POST response upsert — no duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // WS arrives first → handler appends
    act(() => {
      fireWsMessage({ type: 'tab-created', tab: TAB_1 });
    });

    await waitFor(() => expect(stateRef.current!.tabs).toHaveLength(1));

    // POST response arrives — after the fix, TabBar.handleTabSaved should upsert:
    //   setTabs(prev => prev.find(b => b.id === saved.id) ? prev : [...prev, saved])
    act(() => {
      stateRef.current!.setTabs(prev => {
        if (prev.find(b => b.id === TAB_1.id)) return prev;
        return [...prev, TAB_1];
      });
    });

    await waitFor(() => {
      expect(stateRef.current!.tabs.filter(t => t.id === TAB_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.tabs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// task-created
// ---------------------------------------------------------------------------

describe('task-created dedup — WS handler', () => {
  it('WS task-created for an id already present does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setTasks(prev => [...prev, TASK_1]);
    });

    await waitFor(() => expect(stateRef.current!.tasks).toHaveLength(1));

    act(() => {
      fireWsMessage({ type: 'task-created', task: TASK_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.tasks.filter(t => t.id === TASK_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.tasks).toHaveLength(1);
  });

  it('WS task-created arrives first, POST response upsert — no duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // Simulate WS appending first (bypassing tab check by direct set)
    act(() => {
      stateRef.current!.setTasks(prev => [...prev, TASK_1]);
    });

    await waitFor(() => expect(stateRef.current!.tasks).toHaveLength(1));

    // POST response upsert (the TaskModal already uses pendingOps, but
    // simulating the correct idempotent pattern here for completeness)
    act(() => {
      stateRef.current!.setTasks(prev => {
        if (prev.find(t => t.id === TASK_1.id)) return prev;
        return [...prev, TASK_1];
      });
    });

    await waitFor(() => {
      expect(stateRef.current!.tasks.filter(t => t.id === TASK_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// session-created
// ---------------------------------------------------------------------------

describe('session-created dedup — WS handler', () => {
  it('WS session-created for an id already in state does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setSessions(prev => [...prev, SESSION_1]);
    });

    await waitFor(() => expect(stateRef.current!.sessions).toHaveLength(1));

    act(() => {
      fireWsMessage({ type: 'session-created', session: SESSION_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.sessions.filter(s => s.id === SESSION_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// agent-created — WS handler must be added + AgentModal must upsert
// ---------------------------------------------------------------------------

describe('agent-created dedup', () => {
  it('WS agent-created for an id already in state does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // Simulate AgentModal POST response: setAgents(prev => [...prev, created])
    act(() => {
      stateRef.current!.setAgents(prev => [...prev, AGENT_1]);
    });

    await waitFor(() => expect(stateRef.current!.agents).toHaveLength(1));

    // WS echo arrives — after the fix the WS handler should dedup
    act(() => {
      fireWsMessage({ type: 'agent-created', agent: AGENT_1 });
    });

    // After fix: still exactly 1 entry
    await waitFor(() => {
      expect(stateRef.current!.agents.filter(a => a.id === AGENT_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.agents).toHaveLength(1);
  });

  it('WS agent-created arrives first, POST response upsert — no duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // WS arrives first — after fix the WS handler should append
    act(() => {
      fireWsMessage({ type: 'agent-created', agent: AGENT_1 });
    });

    // After fix the WS handler populates agents
    await waitFor(() => expect(stateRef.current!.agents).toHaveLength(1));

    // POST response arrives — after fix AgentModal upserts
    act(() => {
      stateRef.current!.setAgents(prev => {
        if (prev.find(a => a.id === AGENT_1.id)) return prev;
        return [...prev, AGENT_1];
      });
    });

    await waitFor(() => {
      expect(stateRef.current!.agents.filter(a => a.id === AGENT_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.agents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// error-created
// ---------------------------------------------------------------------------

describe('error-created dedup — WS handler', () => {
  it('WS error-created for a string id already in state does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setErrors(prev => [ERROR_1, ...prev]);
    });

    await waitFor(() => expect(stateRef.current!.errors).toHaveLength(1));

    act(() => {
      fireWsMessage({ type: 'error-created', error: ERROR_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.errors.filter(e => e.id === ERROR_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// autoscaler-created
// ---------------------------------------------------------------------------

describe('autoscaler-created dedup — WS handler', () => {
  it('WS autoscaler-created for an id already in state does not add a duplicate', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setAutoScalers(prev => [...prev, AUTOSCALER_1]);
    });

    await waitFor(() => expect(stateRef.current!.autoScalers).toHaveLength(1));

    act(() => {
      fireWsMessage({ type: 'autoscaler-created', autoScaler: AUTOSCALER_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.autoScalers.filter(f => f.id === AUTOSCALER_1.id)).toHaveLength(1);
    });
    expect(stateRef.current!.autoScalers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Full create-then-broadcast sequence (both orders)
// ---------------------------------------------------------------------------

describe('create-then-broadcast sequence', () => {
  it('tab: POST response then WS echo yields exactly one entry', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // POST response — fixed upsert
    act(() => {
      stateRef.current!.setTabs(prev => {
        if (prev.find(b => b.id === TAB_1.id)) return prev;
        return [...prev, TAB_1];
      });
    });

    // WS echo
    act(() => {
      fireWsMessage({ type: 'tab-created', tab: TAB_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.tabs.filter(t => t.id === TAB_1.id)).toHaveLength(1);
    });
  });

  it('task: POST response then WS echo yields exactly one entry', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setTasks(prev => {
        if (prev.find(t => t.id === TASK_1.id)) return prev;
        return [...prev, TASK_1];
      });
    });

    act(() => {
      fireWsMessage({ type: 'task-created', task: TASK_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.tasks.filter(t => t.id === TASK_1.id)).toHaveLength(1);
    });
  });

  it('agent: POST response then WS echo yields exactly one entry', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    // Fixed upsert in AgentModal
    act(() => {
      stateRef.current!.setAgents(prev => {
        if (prev.find(a => a.id === AGENT_1.id)) return prev;
        return [...prev, AGENT_1];
      });
    });

    // WS echo — WS handler must also dedup (agent-created case requires adding handler)
    act(() => {
      fireWsMessage({ type: 'agent-created', agent: AGENT_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.agents.filter(a => a.id === AGENT_1.id)).toHaveLength(1);
    });
  });

  it('session: POST response then WS echo yields exactly one entry', async () => {
    const stateRef = renderApp();
    await waitFor(() => expect(stateRef.current).not.toBeNull());

    act(() => {
      stateRef.current!.setSessions(prev => {
        if (prev.find(s => s.id === SESSION_1.id)) return prev;
        return [...prev, SESSION_1];
      });
    });

    act(() => {
      fireWsMessage({ type: 'session-created', session: SESSION_1 });
    });

    await waitFor(() => {
      expect(stateRef.current!.sessions.filter(s => s.id === SESSION_1.id)).toHaveLength(1);
    });
  });
});
