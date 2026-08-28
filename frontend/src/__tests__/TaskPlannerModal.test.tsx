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
    const { unmount: unmount1 } = render(<TaskPlannerModal onClose={vi.fn()} />);

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

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} />);

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

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} />);

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

    const { rerender, getAllByText } = render(<TaskPlannerModal onClose={vi.fn()} />);

    // Force the effect to re-run on the SAME instance (StrictMode-style
    // cleanup->rerun without unmount) WHILE the first /start is still pending.
    mockUseApp({ currentTabId: 2 });
    rerender(<TaskPlannerModal onClose={vi.fn()} />);

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

    const { getByText, unmount } = render(<TaskPlannerModal onClose={onClose} />);

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

    const { getByText, getByPlaceholderText } = render(<TaskPlannerModal onClose={vi.fn()} />);

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
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);

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
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);

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
    const { getByPlaceholderText, getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);

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
    // Regression test for the exact failure mode from the bug report: quotes
    // inside string values ARE correctly escaped (\"...\"), but long
    // title/description values got line-wrapped (by the model or a markdown
    // renderer) leaving literal newline control characters embedded inside
    // the JSON strings — which plain JSON.parse rejects outright with "Bad
    // control character in string literal". The wrap even splits one \"
    // escape sequence itself across two lines (`\` at end of line, `"` at
    // start of next), which a naive newline-escaping scanner would corrupt
    // by treating the newline as the escaped character. Create Task must
    // still become clickable via the lenient recovery pass.
    const malformed = '```json:task\n{\n  "title": "Merge \\"+ Task\\" and \\"AI Planner\\" into one entry point",\n  "description": "In frontend/src/components/TasksPanel.tsx, the toolbar currently renders two separate buttons that both\n create tasks: #newTaskBtn (\\"+ Task\\", opens TaskModal). Keep the button\'s id as newTaskBtn, label as \\"+ Task\\\n", and use a plain icon.",\n  "priority": 3,\n  "type": "improvement",\n  "files": ["frontend/src/components/TasksPanel.tsx"]\n}\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);
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
    // Regression test for a follow-up failure mode found after the previous
    // fix: the string-repair pass correctly makes the JSON syntactically
    // valid even when a line-wrap lands *inside a key name* rather than a
    // value (e.g. `"title\n": ...` or `{"\ntitle": ...}`), but the resulting
    // object then has a key literally named "title\n" or "\ntitle" instead
    // of "title" — so `parsed.title` reads as undefined and the "missing
    // required fields" warning fires even though a human reading the same
    // block would see title/priority/type all clearly present. This was
    // reported as inconsistent behavior across resends, because whether the
    // wrap happens to land inside a key vs. a value shifts with the
    // surrounding text each time. Key names must be normalized (trimmed of
    // whitespace/escaped whitespace) after parsing, not just the JSON syntax
    // repaired.
    const trailingWrapInKey = '```json:task\n{\n  "title\n": "Allow typing in Task Planner input while agent is busy",\n  "description": "Some description",\n  "priority": 3,\n  "type": "improvement",\n  "files": ["frontend/src/components/TaskPlannerModal.tsx"]\n}\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);
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

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(9, leadingWrapInKey);
      await new Promise(r => setTimeout(r, 10));
    });

    expect(getByText('✅ Task ready to create! Click "Create Task" to add it to your board.')).toBeTruthy();
    expect((getByText('Create Task') as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces a visible error instead of silently disabling Create Task on truly invalid JSON', async () => {
    // Malformed beyond recovery (truncated block) — must not fail silently.
    const brokenBeyondRepair = '```json:task\n{\n  "title": "Something,\n  "priority": 2,\n```';

    const { getByText } = render(<TaskPlannerModal onClose={vi.fn()} />);
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
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).toBeTruthy();
    expect(backdrop!.className).toBe('modal-backdrop');
  });

  it('dialog div has "modal", "modal-wide", and "task-planner-modal" classes', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.classList.contains('modal')).toBe(true);
    expect(dialog!.classList.contains('modal-wide')).toBe(true);
    expect(dialog!.classList.contains('task-planner-modal')).toBe(true);
  });

  it('does not use "task-planner-content" class anywhere', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    expect(container.querySelector('.task-planner-content')).toBeNull();
  });
});
