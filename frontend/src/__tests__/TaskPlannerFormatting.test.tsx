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

function setupApiFetchMock(sessionId: number = 50) {
  const apiFetchMock = vi.mocked(api.apiFetch);
  apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (url === '/api/task-planner/start' && opts?.method === 'POST') {
      return { ok: true, json: async () => ({ sessionId }) } as Response;
    }
    if (opts?.method === 'DELETE') {
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  return apiFetchMock;
}

function dispatchAssistantMessage(sessionId: number, text: string) {
  window.dispatchEvent(new CustomEvent('ws-session-output', {
    detail: { sessionId, entry: { stream: 'stdout', text } },
  }));
  window.dispatchEvent(new CustomEvent('ws-session-activity', {
    detail: { sessionId, activity: { type: 'idle' } },
  }));
}

describe('TaskPlannerModal - fence stripping (Part A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApiFetchMock(50);
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('strips the successfully parsed json:task fence from the displayed assistant message', async () => {
    const messageWithFence = 'Here is your task:\n\n```json:task\n{ "title": "Fix bug", "priority": 2, "type": "bug" }\n```\n\nLet me know if you want changes.';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(50, messageWithFence);
      await new Promise(r => setTimeout(r, 10));
    });

    // The assistant message bubble should NOT contain the raw JSON block
    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant).toBeTruthy();
    expect(lastAssistant!.textContent).not.toContain('"title": "Fix bug"');
    // But surrounding prose should still be there
    expect(lastAssistant!.textContent).toContain('Here is your task');
    expect(lastAssistant!.textContent).toContain('Let me know if you want changes');
  });

  it('strips a plain ```json fence that was successfully parsed', async () => {
    const messageWithPlainFence = 'Task below:\n\n```json\n{ "title": "Add feature", "priority": 3, "type": "feature" }\n```';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(50, messageWithPlainFence);
      await new Promise(r => setTimeout(r, 10));
    });

    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant).toBeTruthy();
    expect(lastAssistant!.textContent).not.toContain('"title": "Add feature"');
    expect(lastAssistant!.textContent).toContain('Task below');
  });

  it('does NOT strip the fence when parsing fails (invalid JSON)', async () => {
    const messageWithBrokenFence = 'Here is your task:\n\n```json:task\n{ "title": "Broken,\n```\n\nSorry about that.';

    const { container, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(50, messageWithBrokenFence);
      await new Promise(r => setTimeout(r, 10));
    });

    // The "could not parse" warning should appear
    expect(getByText(/Could not parse the task block above/)).toBeTruthy();

    // The raw JSON should still be visible in the assistant message
    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant).toBeTruthy();
    expect(lastAssistant!.textContent).toContain('"title": "Broken,');
  });

  it('also strips the fence from the live streaming partial message', async () => {
    const messageWithFence = 'Here is your task:\n\n```json:task\n{ "title": "Streaming test", "priority": 1, "type": "bug" }\n```';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Simulate streaming: output event makes a __PARTIAL__ message, then activity flushes it
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-output', {
        detail: { sessionId: 50, entry: { stream: 'stdout', text: messageWithFence } },
      }));
      await new Promise(r => setTimeout(r, 10));
    });

    // Now flush via activity event (triggers tryParseTask)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-activity', {
        detail: { sessionId: 50, activity: { type: 'idle' } },
      }));
      await new Promise(r => setTimeout(r, 10));
    });

    // The flushed assistant message should have the fence stripped
    const assistantMessages = container.querySelectorAll('.planner-message.assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    expect(lastAssistant).toBeTruthy();
    expect(lastAssistant!.textContent).not.toContain('"title": "Streaming test"');
    expect(lastAssistant!.textContent).toContain('Here is your task');
  });
});

describe('TaskPlannerModal - TaskCard preview (Part B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApiFetchMock(60);
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a TaskCard preview when a task is successfully parsed', async () => {
    const message = '```json:task\n{ "title": "Preview test", "priority": 2, "type": "feature" }\n```';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(60, message);
      await new Promise(r => setTimeout(r, 10));
    });

    // Should render a TaskCard (has .task-card class)
    const taskCard = container.querySelector('.task-card');
    expect(taskCard).toBeTruthy();
    expect(taskCard!.textContent).toContain('Preview test');
    expect(taskCard!.textContent).toContain('Feature');
    expect(taskCard!.textContent).toContain('P2');
  });

  it('does not render a TaskCard when no task is parsed', async () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    const taskCard = container.querySelector('.task-card');
    expect(taskCard).toBeNull();
  });

  it('TaskCard preview is not draggable', async () => {
    const message = '```json:task\n{ "title": "No drag", "priority": 3, "type": "improvement" }\n```';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(60, message);
      await new Promise(r => setTimeout(r, 10));
    });

    const taskCard = container.querySelector('.task-card');
    expect(taskCard).toBeTruthy();
    expect(taskCard!.getAttribute('draggable')).toBe('false');
  });

  it('TaskCard preview shows origin icon for "ai" origin', async () => {
    const message = '```json:task\n{ "title": "AI task", "priority": 2, "type": "bug" }\n```';

    const { container } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(60, message);
      await new Promise(r => setTimeout(r, 10));
    });

    const taskCard = container.querySelector('.task-card');
    expect(taskCard).toBeTruthy();
    // The AI origin icon (🤖) should be present
    expect(taskCard!.textContent).toContain('\u{1F916}');
  });
});
