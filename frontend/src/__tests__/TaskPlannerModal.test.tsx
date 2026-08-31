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
