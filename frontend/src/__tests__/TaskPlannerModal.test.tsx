import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { act } from 'react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
  TYPE_CLASSES: {
    improvement: 'badge-improvement',
    bug: 'badge-bug',
    feature: 'badge-feature',
  },
  ORIGIN_ICONS: {
    user: '\u{1F464}',
    ai: '\u{1F916}',
    'user-assisted': '\u{1F91D}',
  },
}));

import { TaskPlannerModal } from '../components/TaskPlannerModal';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    currentTabId: 1,
    setTasks: vi.fn(),
    sessions: [],
    setSessions: vi.fn(),
    tabs: [{ id: 1, name: 'Test Tab' }],
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('TaskPlannerModal - session leak prevention', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
  });

  afterEach(() => {
    cleanup();
  });

  it('cleans up orphaned session when effect is re-run (StrictMode double-invoke)', async () => {
    // Simulate two sessions being created by sequential mounts (StrictMode behavior)
    // First call returns session 100, second call returns session 200
    let callCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        callCount++;
        const sessionId = callCount === 1 ? 100 : 200;
        return {
          ok: true,
          json: async () => ({ sessionId }),
        };
      }
      // DELETE calls for cleanup
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    // Simulate StrictMode: mount -> unmount -> mount
    // First mount
    const { unmount: unmount1 } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Let the first session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Unmount (StrictMode cleanup) — this should trigger cleanup of session 100
    unmount1();

    // Allow async cleanup to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // The orphaned session (100) should be cleaned up via DELETE
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/100');
  });

  it('cleans up the orphaned session when unmount happens BEFORE /start resolves (true StrictMode timing)', async () => {
    // React StrictMode's mount->cleanup->remount cycle runs the cleanup
    // synchronously, immediately after mount — well before any in-flight
    // network request has a chance to resolve. Use a manually-controlled
    // deferred promise so we can unmount while /start is still pending,
    // then resolve it afterward, to reproduce that exact ordering.
    let resolveStart: ((value: { ok: boolean; json: () => Promise<{ sessionId: number }> }) => void) | null = null;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<{ sessionId: number }> }>((resolve) => {
      resolveStart = resolve;
    });

    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return startPromise;
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Unmount immediately — /start is still pending, so at this point
    // createdSessionId is still null inside the effect closure.
    unmount();

    // Now let /start resolve, AFTER cleanup has already run.
    await act(async () => {
      resolveStart!({ ok: true, json: async () => ({ sessionId: 100 }) });
      await new Promise(r => setTimeout(r, 10));
    });

    // The session created by the now-cancelled effect must still be deleted —
    // not silently abandoned/leaked as a live backend session + kiro-cli process.
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/100');
  });

  it('cleans up session on unmount even if fetch already resolved', async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 42 }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Let the session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Unmount the component (user closes modal quickly, or StrictMode cleanup)
    unmount();

    // Allow async cleanup to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Session 42 should be cleaned up via DELETE on unmount
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/42');
  });

  it('does not show a duplicate "Starting..." message under StrictMode double-invoke', async () => {
    // Reproduces the real StrictMode dev race: the effect's cleanup for the
    // FIRST run fires before its /start call has resolved (so that run is
    // cancelled pre-adoption), then the SECOND run's /start resolves and is
    // adopted. Both runs call setMessages on the same component instance, so
    // a naive unconditional addMessage() at the top of the effect leaves two
    // "Starting..." lines behind even though only one session is ever live.
    let resolveFirstStart: ((value: { ok: boolean; json: () => Promise<{ sessionId: number }> }) => void) | null = null;
    const firstStartPromise = new Promise<{ ok: boolean; json: () => Promise<{ sessionId: number }> }>((resolve) => {
      resolveFirstStart = resolve;
    });
    let startCallCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        startCallCount++;
        if (startCallCount === 1) return firstStartPromise;
        return { ok: true, json: async () => ({ sessionId: 200 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { rerender, getAllByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Force the effect to re-run on the SAME instance (StrictMode-style
    // cleanup->rerun without unmount) WHILE the first /start is still pending.
    mockUseApp({ currentTabId: 2 });
    rerender(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Now resolve the first (now-cancelled) /start call, and let the second
    // run's /start (which resolves synchronously) settle too.
    await act(async () => {
      resolveFirstStart!({ ok: true, json: async () => ({ sessionId: 100 }) });
      await new Promise(r => setTimeout(r, 10));
    });

    // Only one "Starting AI Task Planner..." line should be visible — the
    // first run's message must have been retracted since it was never adopted.
    expect(getAllByText('Starting AI Task Planner...').length).toBe(1);
  });

  it('does not double-delete when handleClose is used normally', async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 55 }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const onClose = vi.fn();
    mockUseApp({ currentTabId: 1 });

    const { getByText, unmount } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);

    // Let the session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // User clicks Cancel button — this triggers handleClose which calls DELETE
    const cancelBtn = getByText('Cancel');
    await act(async () => {
      cancelBtn.click();
    });

    // Allow the async DELETE from handleClose to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Now unmount (triggered by onClose hiding the modal)
    unmount();

    // Allow any async cleanup from the effect to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Session 55 should only be deleted ONCE (not double-deleted)
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url === '/api/task-planner/55' && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
  });
});

describe('TaskPlannerModal - readiness race', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
  });

  afterEach(() => {
    cleanup();
  });

  it('does not mark the session ready off the /start HTTP response alone', async () => {
    // Regression test for: UI showed "Ready" and enabled Send immediately after
    // POST /start resolved, but the backend's kiro-cli child process (session.runner)
    // is spawned asynchronously by startSession() and may not exist yet — so a
    // message sent at that point fails server-side with "Could not send message —
    // session may not be running". Readiness must wait for the WS 'idle'/'completed'
    // session-activity event, not the HTTP response.
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 7 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { getByText, getByPlaceholderText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Let /start resolve.
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Status must still show "Connecting..." and Send must remain disabled —
    // the runner has not been confirmed alive yet.
    expect(getByText('Connecting...')).toBeTruthy();
    const sendBtn = getByText('Send') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    const input = getByPlaceholderText('Describe the task you want to create...') as HTMLTextAreaElement;
    // Textarea is never disabled — users can type while connecting/thinking.
    // Only the Send button gates on readiness.
    expect(input.disabled).toBe(false);

    // Now simulate the real readiness signal: the backend's 'idle' session-activity
    // WS event, fired once session.runner exists and the initial prompt was sent.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-activity', {
        detail: { sessionId: 7, activity: { type: 'idle', detail: 'Waiting for prompts...' } },
      }));
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('Ready')).toBeTruthy();
    // The textarea is never disabled (users can type at any status), so
    // just confirm the Send button becomes enabled once ready with text.
    expect(input.disabled).toBe(false);
  });
});

describe('TaskPlannerModal - Create manually instead', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 1 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a "Create manually instead" button in the actions area', async () => {
    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(getByText('Create manually instead')).toBeInTheDocument();
  });

  it('clicking "Create manually instead" calls handleClose cleanup then onSwitchToManual', async () => {
    const onClose = vi.fn();
    const onSwitchToManual = vi.fn();
    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={onSwitchToManual} />);

    // Let session start resolve
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Click "Create manually instead"
    await act(async () => {
      getByText('Create manually instead').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Should have called DELETE for cleanup (same as Cancel)
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);

    // onClose should have been called (from handleClose)
    expect(onClose).toHaveBeenCalled();
    // onSwitchToManual should have been called after cleanup
    expect(onSwitchToManual).toHaveBeenCalled();
  });
});

describe('TaskPlannerModal - textarea always typeable', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 10 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('textarea is not disabled when ready is false (connecting state)', async () => {
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    // Let /start resolve — session created but no WS idle event yet, so ready=false.
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Confirm we're still in connecting state (not ready).
    expect(getByText('Connecting...')).toBeTruthy();

    // Textarea must NOT be disabled — user should be able to type while waiting.
    const input = getByPlaceholderText('Describe the task you want to create...') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
  });

  it('Send button remains disabled when ready is false even with text typed', async () => {
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Type some text while not ready.
    const input = getByPlaceholderText('Describe the task you want to create...') as HTMLTextAreaElement;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(input, 'my next message');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Send button must still be disabled (ready is false).
    const sendBtn = getByText('Send') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('pressing Enter while not ready does not clear the typed text', async () => {
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);

    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Confirm not ready.
    expect(getByText('Connecting...')).toBeTruthy();

    const input = getByPlaceholderText('Describe the task you want to create...') as HTMLTextAreaElement;

    // Type some text.
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(input, 'queued message');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Press Enter (without Shift) — handleSend should early-return, preserving text.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // The text must still be there (not cleared by handleSend).
    expect(input.value).toBe('queued message');

    // No message was sent to the API (handleSend early-returned).
    const messageCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/message') && opts?.method === 'POST'
    );
    expect(messageCalls.length).toBe(0);
  });
});

describe('TaskPlannerModal - task JSON parsing', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 9 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchAssistantMessage(sessionId: number, text: string) {
    // Simulate the backend streaming the assistant's final message via WS,
    // the same path tryParseTask() is wired to through the 'idle' activity event.
    window.dispatchEvent(new CustomEvent('ws-session-output', {
      detail: { sessionId, entry: { stream: 'stdout', text } },
    }));
    window.dispatchEvent(new CustomEvent('ws-session-activity', {
      detail: { sessionId, activity: { type: 'idle' } },
    }));
  }

  it('recovers a task block whose long strings were line-wrapped, including a split \\" escape', async () => {
    const malformed = '```json:task\n{\n  "title": "Merge \\"+ Task\\" and \\"AI Planner\\" into one entry point",\n  "description": "In frontend/src/components/TasksPanel.tsx, the toolbar currently renders two separate buttons that both\n create tasks: #newTaskBtn (\\"+ Task\\", opens TaskModal). Keep the button\'s id as newTaskBtn, label as \\"+ Task\\\n", and use a plain icon.",\n  "priority": 3,\n  "type": "improvement",\n  "files": ["frontend/src/components/TasksPanel.tsx"]\n}\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, malformed);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();
    const createBtn = getByText('Create Task') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(false);
  });

  it('resolves title/priority/type even when the line wrap lands inside a key name, not just a value', async () => {
    const trailingWrapInKey = '```json:task\n{\n  "title\n": "Allow typing in Task Planner input while agent is busy",\n  "description": "Some description",\n  "priority": 3,\n  "type": "improvement",\n  "files": ["frontend/src/components/TaskPlannerModal.tsx"]\n}\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, trailingWrapInKey);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();
    expect((getByText('Create Task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('resolves title even when the line wrap lands right after the opening quote of a key', async () => {
    const leadingWrapInKey = '```json:task\n{"\ntitle": "Allow typing in Task Planner input while agent is busy", "priority": 3, "type": "improvement"}\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, leadingWrapInKey);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();
    expect((getByText('Create Task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces a visible error instead of silently disabling Create Task on truly invalid JSON', async () => {
    const brokenBeyondRepair = '```json:task\n{\n  "title": "Something,\n  "priority": 2,\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, brokenBeyondRepair);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText(/Could not parse the task block above/)).toBeTruthy();
    const createBtn = getByText('Create Task') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });
});

describe('TaskPlannerModal - modal CSS class structure', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 1 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('backdrop div has only "modal-backdrop" class, not "task-planner-modal"', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).toBeTruthy();
    expect(backdrop!.className).toBe('modal-backdrop');
  });

  it('dialog div has "modal", "modal-wide", and "task-planner-modal" classes', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.classList.contains('modal')).toBe(true);
    expect(dialog!.classList.contains('modal-wide')).toBe(true);
    expect(dialog!.classList.contains('task-planner-modal')).toBe(true);
  });

  it('does not use "task-planner-content" class anywhere', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    expect(container.querySelector('.task-planner-content')).toBeNull();
  });
});

describe('TaskPlannerModal - attachment cap message deduplication', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 20 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows at most one cap-exceeded message when pasting more images than remaining slots', async () => {
    // Pasting 5 images when 0 are attached should add exactly 3 (the cap)
    // and show at most ONE "Maximum of 3 images per message." system message —
    // NOT one per rejected file.
    const { container, getAllByText, queryAllByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Create 5 small PNG files
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG header
    const files: File[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(new File([pngBytes], `image${i + 1}.png`, { type: 'image/png' }));
    }

    // Simulate a paste event with all 5 images
    const dataTransfer = {
      items: files.map(f => ({
        kind: 'file' as const,
        type: f.type,
        getAsFile: () => f,
      })),
      get length() { return this.items.length; },
    };

    await act(async () => {
      const pasteEvent = new Event('paste', { bubbles: true }) as any;
      pasteEvent.clipboardData = dataTransfer;
      window.dispatchEvent(pasteEvent);
      // Let FileReader onload callbacks fire
      await new Promise(r => setTimeout(r, 50));
    });

    // Exactly 3 attachment chips should be rendered (the cap)
    const chips = container.querySelectorAll('.task-planner-attachment');
    expect(chips.length).toBe(3);

    // The cap-exceeded message should appear at most ONCE — not twice for
    // the 2 rejected files.
    const capMessages = queryAllByText(/Maximum of 3 images per message/);
    expect(capMessages.length).toBe(1);
  });
});

describe('TaskPlannerModal - fence stripping on successful parse', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 9 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchAssistantMessage(sessionId: number, text: string) {
    window.dispatchEvent(new CustomEvent('ws-session-output', {
      detail: { sessionId, entry: { stream: 'stdout', text } },
    }));
    window.dispatchEvent(new CustomEvent('ws-session-activity', {
      detail: { sessionId, activity: { type: 'idle' } },
    }));
  }

  it('strips the parsed json:task fence block from the rendered assistant message', async () => {
    const messageWithFence = 'Here is the task I created:\n\n```json:task\n{"title": "Fix bug", "priority": 2, "type": "bug"}\n```\n\nLet me know if you want changes.';

    const { container, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, messageWithFence);
      await new Promise(r => setTimeout(r, 10));
    });

    // The task-ready system message should appear
    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();

    // The raw JSON block should NOT appear in any assistant message
    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    for (const msg of assistantMessages) {
      expect(msg.textContent).not.toContain('"title": "Fix bug"');
      expect(msg.textContent).not.toContain('json:task');
    }

    // But the surrounding prose SHOULD still appear
    const allText = Array.from(assistantMessages).map(m => m.textContent).join(' ');
    expect(allText).toContain('Here is the task I created');
    expect(allText).toContain('Let me know if you want changes');
  });

  it('does NOT strip the fence block when JSON parsing fails', async () => {
    const brokenJson = 'Here is the task:\n\n```json:task\n{"title": "Something,\n"priority": 2,\n```\n\nPlease review.';

    const { container, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, brokenJson);
      await new Promise(r => setTimeout(r, 10));
    });

    // The error message should appear
    expect(getByText(/Could not parse the task block above/)).toBeTruthy();

    // The raw fence content SHOULD still be visible since parsing failed
    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    const allText = Array.from(assistantMessages).map(m => m.textContent).join(' ');
    expect(allText).toContain('title');
  });
});

describe('TaskPlannerModal - TaskCard preview', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 9 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchAssistantMessage(sessionId: number, text: string) {
    window.dispatchEvent(new CustomEvent('ws-session-output', {
      detail: { sessionId, entry: { stream: 'stdout', text } },
    }));
    window.dispatchEvent(new CustomEvent('ws-session-activity', {
      detail: { sessionId, activity: { type: 'idle' } },
    }));
  }

  it('renders a TaskCard preview when a valid json:task block is parsed', async () => {
    const messageWithTask = '```json:task\n{"title": "Add pagination", "priority": 3, "type": "feature", "description": "Paginate results"}\n```';

    const { container, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, messageWithTask);
      await new Promise(r => setTimeout(r, 10));
    });

    // Task ready message should appear
    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();

    // A TaskCard preview should be rendered with the parsed task data
    expect(getByText('Add pagination')).toBeTruthy();
    expect(getByText('Feature')).toBeTruthy();
    expect(getByText('P3')).toBeTruthy();

    // The preview card should not be draggable
    const previewCard = container.querySelector('.task-planner-preview .task-card');
    expect(previewCard).toBeTruthy();
    expect(previewCard).toHaveAttribute('draggable', 'false');
  });

  it('does not render TaskCard preview when no task has been parsed', async () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    expect(container.querySelector('.task-planner-preview')).toBeNull();
  });
});

describe('TaskPlannerModal - multi-task batch support', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchAssistantMessage(sessionId: number, text: string) {
    window.dispatchEvent(new CustomEvent('ws-session-output', {
      detail: { sessionId, entry: { stream: 'stdout', text } },
    }));
    window.dispatchEvent(new CustomEvent('ws-session-activity', {
      detail: { sessionId, activity: { type: 'idle' } },
    }));
  }

  it('parses a JSON array of tasks and shows "Create Tasks" (plural) button', async () => {
    const arrayBlock = '```json:task\n[\n  { "title": "Task A", "priority": 2, "type": "feature" },\n  { "title": "Task B", "priority": 3, "type": "bug" }\n]\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, arrayBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // Should show plural button text
    expect(getByText('Create Tasks')).toBeTruthy();
    expect((getByText('Create Tasks') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows "Create Task" (singular) for a single-element array', async () => {
    const singleArrayBlock = '```json:task\n[\n  { "title": "Only task", "priority": 1, "type": "bug" }\n]\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, singleArrayBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('Create Task')).toBeTruthy();
    expect((getByText('Create Task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('tolerates a single object (not wrapped in array) as backward compat', async () => {
    const singleObjectBlock = '```json:task\n{ "title": "Solo task", "priority": 2, "type": "improvement" }\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, singleObjectBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // Single object → length-1 batch → singular button
    expect(getByText('Create Task')).toBeTruthy();
    expect((getByText('Create Task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejects batch if any task is missing required fields', async () => {
    const invalidBatch = '```json:task\n[\n  { "title": "Valid", "priority": 2, "type": "feature" },\n  { "title": "Invalid — no priority", "type": "bug" }\n]\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, invalidBatch);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText(/missing required fields/)).toBeTruthy();
    // parsedTasks should remain null, so the default disabled "Create Task" button is shown
    const createBtn = getByText('Create Task') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it('sends batch body to create-task endpoint and closes modal on full success', async () => {
    const batchBlock = '```json:task\n[\n  { "title": "Task A", "priority": 2, "type": "feature" },\n  { "title": "Task B", "priority": 3, "type": "bug" }\n]\n```';

    const onClose = vi.fn();
    const setTasks = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    // First mock: /start, then create-task response
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 100, title: 'Task A', priority: 2, type: 'feature', state: 'todo' },
              { id: 101, title: 'Task B', priority: 3, type: 'bug', state: 'todo' },
            ],
            failed: [],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Simulate receiving the batch output
    await act(async () => {
      dispatchAssistantMessage(30, batchBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // Click "Create Tasks"
    const createBtn = getByText('Create Tasks') as HTMLButtonElement;
    await act(async () => {
      createBtn.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // setTasks should have been called to add both tasks
    expect(setTasks).toHaveBeenCalled();
    // Modal should close on full success
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps modal open and shows error on partial failure', async () => {
    const batchBlock = '```json:task\n[\n  { "title": "Task A", "priority": 2, "type": "feature" },\n  { "title": "Task B", "priority": 3, "type": "bug" }\n]\n```';

    const onClose = vi.fn();
    const setTasks = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 100, title: 'Task A', priority: 2, type: 'feature', state: 'todo' },
            ],
            failed: [
              { task: { title: 'Task B', priority: 3, type: 'bug' }, error: 'DB connection lost' },
            ],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, batchBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    await act(async () => {
      getByText('Create Tasks').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Modal should NOT close on partial failure
    expect(onClose).not.toHaveBeenCalled();
    // Should show the error for the failed task
    expect(getByText(/Task B.*failed.*DB connection lost/)).toBeTruthy();
    // Successfully created tasks should still be added
    expect(setTasks).toHaveBeenCalled();
  });

  it('updates parsedTasks to only failed tasks after partial failure, preventing duplicates on retry', async () => {
    const batchBlock = '```json:task\n[\n  { "title": "Task A", "priority": 2, "type": "feature" },\n  { "title": "Task B", "priority": 3, "type": "bug" },\n  { "title": "Task C", "priority": 1, "type": "improvement" }\n]\n```';

    const onClose = vi.fn();
    const setTasks = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    let createCallCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        createCallCount++;
        if (createCallCount === 1) {
          // First call: partial failure — A and C succeed, B fails
          return {
            ok: true,
            json: async () => ({
              created: [
                { id: 100, title: 'Task A', priority: 2, type: 'feature', state: 'todo' },
                { id: 102, title: 'Task C', priority: 1, type: 'improvement', state: 'todo' },
              ],
              failed: [
                { task: { title: 'Task B', priority: 3, type: 'bug' }, error: 'DB connection lost' },
              ],
            }),
          };
        }
        // Second call (retry): all succeed
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 103, title: 'Task B', priority: 3, type: 'bug', state: 'todo' },
            ],
            failed: [],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, batchBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // First click — partial failure
    await act(async () => {
      getByText('Create Tasks').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Modal stays open, button should now show singular "Create Task" since only 1 failed task remains
    expect(onClose).not.toHaveBeenCalled();
    const retryBtn = getByText('Create Task') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(false);

    // Second click — retry with only the failed task
    await act(async () => {
      retryBtn.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // The retry call should only send 1 task (Task B), not all 3
    const createCalls = apiFetchMock.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('/create-task') && call[1]?.method === 'POST'
    );
    expect(createCalls).toHaveLength(2);
    const retryBody = JSON.parse(createCalls[1][1].body as string);
    expect(retryBody.tasks).toHaveLength(1);
    expect(retryBody.tasks[0].title).toBe('Task B');

    // Now modal should close on full success of the retry
    expect(onClose).toHaveBeenCalled();
  });

  it('preserves dependsOnTaskId on retry after partial failure', async () => {
    // Task B has dependsOnTaskId: [99] (a real existing task), and fails on first attempt.
    // On retry, the dependsOnTaskId should still be present in the request body.
    const batchBlock = '```json:task\n[\n  { "title": "Task A", "priority": 2, "type": "feature" },\n  { "title": "Task B", "priority": 3, "type": "bug", "dependsOnTaskId": [99] }\n]\n```';

    const onClose = vi.fn();
    const setTasks = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    let createCallCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        createCallCount++;
        if (createCallCount === 1) {
          return {
            ok: true,
            json: async () => ({
              created: [
                { id: 100, title: 'Task A', priority: 2, type: 'feature', state: 'todo' },
              ],
              failed: [
                { task: { title: 'Task B', priority: 3, type: 'bug', dependsOnTaskId: [99] }, error: 'DB error' },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 101, title: 'Task B', priority: 3, type: 'bug', state: 'todo' },
            ],
            failed: [],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, batchBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // First click — partial failure
    await act(async () => {
      getByText('Create Tasks').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Retry
    const retryBtn = getByText('Create Task') as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // The retry request body should include dependsOnTaskId for Task B
    const createCalls = apiFetchMock.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('/create-task') && call[1]?.method === 'POST'
    );
    expect(createCalls).toHaveLength(2);
    const retryBody = JSON.parse(createCalls[1][1].body as string);
    expect(retryBody.tasks).toHaveLength(1);
    expect(retryBody.tasks[0].title).toBe('Task B');
    expect(retryBody.tasks[0].dependsOnTaskId).toEqual([99]);
  });

  it('parses tasks with dependsOnBatchIndex and groupId fields', async () => {
    const batchWithDeps = '```json:task\n[\n  { "title": "Base task", "priority": 2, "type": "feature" },\n  { "title": "Dep task", "priority": 2, "type": "feature", "dependsOnBatchIndex": [0], "groupId": "grp1" }\n]\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, batchWithDeps);
      await new Promise(r => setTimeout(r, 10));
    });

    // Should parse successfully and show create button
    expect(getByText('Create Tasks')).toBeTruthy();
    expect((getByText('Create Tasks') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sanitizes leading escaped newline in string values (e.g. type) before sending to create-task', async () => {
    // Regression: the planner LLM occasionally wraps a line so that a literal
    // newline lands right after a value's opening quote — e.g. "type": "\nbug".
    // The repair pass re-escapes the raw newline into \\n so JSON.parse succeeds,
    // but the resulting value is "\nbug" instead of "bug". normalizeKeys only
    // cleaned keys, not values, so the corrupted value was sent to the backend.
    const wrappedValueBlock = '```json:task\n{\n  "title": "Fix broken parser",\n  "description": "Some description",\n  "priority": 2,\n  "type": "\nbug",\n  "files": ["\nfrontend/src/foo.ts"]\n}\n```';

    const setTasks = vi.fn();
    const onClose = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 300, title: 'Fix broken parser', priority: 2, type: 'bug', state: 'todo' },
            ],
            failed: [],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, wrappedValueBlock);
      await new Promise(r => setTimeout(r, 10));
    });

    // Task should be parsed successfully (the corrupted "\nbug" is truthy, so it passes validation)
    expect(getByText('Create Task')).toBeTruthy();

    await act(async () => {
      getByText('Create Task').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Verify the POST body sent to /create-task has clean values
    const createCall = apiFetchMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('/create-task') && call[1]?.method === 'POST'
    );
    expect(createCall).toBeTruthy();
    const sentBody = JSON.parse(createCall![1].body as string);
    // The type value must be "bug", not "\nbug"
    expect(sentBody.tasks[0].type).toBe('bug');
    // The title should also be clean (no leading/trailing whitespace artifacts)
    expect(sentBody.tasks[0].title).toBe('Fix broken parser');
    // Files entries should also be sanitized
    expect(sentBody.tasks[0].files[0]).toBe('frontend/src/foo.ts');
  });

  it('sends the batch with dependsOnBatchIndex and groupId to the backend', async () => {
    const batchWithDeps = '```json:task\n[\n  { "title": "Base", "priority": 2, "type": "feature", "groupId": "g1" },\n  { "title": "Dep", "priority": 2, "type": "feature", "dependsOnBatchIndex": [0], "groupId": "g1" }\n]\n```';

    const setTasks = vi.fn();
    const onClose = vi.fn();
    mockUseApp({ currentTabId: 1, setTasks });

    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 30 }) };
      }
      if (typeof url === 'string' && url.includes('/create-task') && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            created: [
              { id: 200, title: 'Base', priority: 2, type: 'feature', state: 'todo' },
              { id: 201, title: 'Dep', priority: 2, type: 'feature', state: 'todo' },
            ],
            failed: [],
          }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { getByText } = render(<TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(30, batchWithDeps);
      await new Promise(r => setTimeout(r, 10));
    });

    await act(async () => {
      getByText('Create Tasks').click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Find the create-task call and verify body includes tasks array
    const createCall = apiFetchMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('/create-task') && call[1]?.method === 'POST'
    );
    expect(createCall).toBeTruthy();
    const sentBody = JSON.parse(createCall![1].body as string);
    expect(sentBody.tasks).toHaveLength(2);
    expect(sentBody.tasks[0].groupId).toBe('g1');
    expect(sentBody.tasks[1].dependsOnBatchIndex).toEqual([0]);
    expect(sentBody.tasks[1].groupId).toBe('g1');
  });
});


describe('TaskPlannerModal - Start Over button', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchAssistantMessage(sessionId: number, text: string) {
    window.dispatchEvent(new CustomEvent('ws-session-output', {
      detail: { sessionId, entry: { stream: 'stdout', text } },
    }));
    window.dispatchEvent(new CustomEvent('ws-session-activity', {
      detail: { sessionId, activity: { type: 'idle' } },
    }));
  }

  it('renders a "Start Over" button between Cancel and "Create manually instead"', async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 1 }) };
      }
      if (opts?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    const buttons = Array.from(container.querySelectorAll('.task-planner-actions .btn'));
    const labels = buttons.map(b => b.textContent);
    const cancelIdx = labels.indexOf('Cancel');
    const startOverIdx = labels.indexOf('Start Over');
    const manualIdx = labels.indexOf('Create manually instead');
    expect(startOverIdx).toBeGreaterThan(-1);
    expect(startOverIdx).toBe(cancelIdx + 1);
    expect(manualIdx).toBe(startOverIdx + 1);
    // Styled as a small secondary button
    const startOverBtn = buttons[startOverIdx];
    expect(startOverBtn.classList.contains('btn-secondary')).toBe(true);
    expect(startOverBtn.classList.contains('btn-sm')).toBe(true);
  });

  it('clicking Start Over DELETEs old session, POSTs a new /start, and clears the transcript', async () => {
    let startCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        startCount++;
        return { ok: true, json: async () => ({ sessionId: startCount === 1 ? 500 : 600 }) };
      }
      if (opts?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });

    const { getByText, queryByText, container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Produce an assistant message + parsed task so there is transcript to clear.
    await act(async () => {
      dispatchAssistantMessage(500, '```json:task\n{"title": "Old", "priority": 2, "type": "bug"}\n```');
      await new Promise(r => setTimeout(r, 10));
    });
    expect(queryByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();
    // The parsed-task preview card is rendered.
    expect(container.querySelector('.task-planner-preview')).toBeTruthy();

    // Click Start Over.
    await act(async () => {
      getByText('Start Over').click();
      await new Promise(r => setTimeout(r, 10));
    });

    // The old session (500) must be DELETEd.
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => url === '/api/task-planner/500' && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);

    // A second /start POST must have been issued.
    expect(startCount).toBe(2);

    // The old parsed-task preview must be gone (transcript cleared).
    expect(container.querySelector('.task-planner-preview')).toBeNull();
    expect(queryByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeNull();
  });
});

describe('TaskPlannerModal - outside-click dismiss keeps session alive', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 700 }) };
      }
      if (opts?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('clicking the backdrop calls onDismiss and does NOT DELETE the session', async () => {
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TaskPlannerModal onClose={onClose} onSwitchToManual={vi.fn()} onDismiss={onDismiss} />
    );
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    await act(async () => {
      // Click directly on the backdrop (target === currentTarget).
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });

    expect(onDismiss).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(0);
  });

  it('applies the hidden attribute to the backdrop when hidden prop is true', async () => {
    const { container, rerender } = render(
      <TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} hidden={false} />
    );
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    expect(backdrop.hasAttribute('hidden')).toBe(false);

    await act(async () => {
      rerender(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} hidden={true} />);
    });
    expect(backdrop.hasAttribute('hidden')).toBe(true);
  });
});

describe('TaskPlannerModal - 5-minute idle timer on parked sessions', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 800 }) };
      }
      if (opts?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('DELETEs the session and calls onExpire after 5 minutes hidden', async () => {
    const onExpire = vi.fn();
    const { rerender } = render(
      <TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} onExpire={onExpire} hidden={false} />
    );
    // Let /start resolve.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Park the modal (hidden).
    await act(async () => {
      rerender(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} onExpire={onExpire} hidden={true} />);
    });

    // Advance 5 minutes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    });

    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => url === '/api/task-planner/800' && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
    expect(onExpire).toHaveBeenCalled();
  });

  it('cancels the idle timer when the modal is un-hidden before 5 minutes', async () => {
    const onExpire = vi.fn();
    const { rerender } = render(
      <TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} onExpire={onExpire} hidden={false} />
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Park it.
    await act(async () => {
      rerender(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} onExpire={onExpire} hidden={true} />);
    });
    // Resume before 5 minutes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      rerender(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} onDismiss={vi.fn()} onExpire={onExpire} hidden={false} />);
    });
    // Advance well past the original 5-minute window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });

    expect(onExpire).not.toHaveBeenCalled();
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(0);
  });
});
