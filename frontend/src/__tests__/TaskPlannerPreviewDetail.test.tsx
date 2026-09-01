import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
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

import { TaskPlannerPreviewDetail } from '../components/TaskPlannerPreviewDetail';
import type { ParsedTask } from '../components/TaskPlannerModal';
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

const SAMPLE_TASKS: ParsedTask[] = [
  {
    title: 'First task',
    description: 'First description\nwith a line break',
    priority: 2,
    type: 'feature',
    files: ['frontend/src/a.ts', 'frontend/src/b.ts'],
  },
  {
    title: 'Second task',
    description: 'Second description',
    priority: 1,
    type: 'bug',
    dependsOnBatchIndex: [0],
    groupId: 'grp1',
  },
  {
    title: 'Third task',
    description: 'Third description',
    priority: 3,
    type: 'improvement',
    dependsOnTaskId: [99],
  },
];

describe('TaskPlannerPreviewDetail - standalone', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the task at the given index: title, description, priority, type', () => {
    const { getByText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByText('First task')).toBeTruthy();
    expect(getByText(/First description/)).toBeTruthy();
    expect(getByText('P2')).toBeTruthy();
    expect(getByText('Feature')).toBeTruthy();
  });

  it('renders the files list when present', () => {
    const { getByText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByText('frontend/src/a.ts')).toBeTruthy();
    expect(getByText('frontend/src/b.ts')).toBeTruthy();
  });

  it('shows dependsOnBatchIndex and groupId as labeled raw values when present', () => {
    const { getByText, queryByText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={1}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByText(/Depends on batch index/i)).toBeTruthy();
    expect(getByText(/grp1/)).toBeTruthy();
    // dependsOnTaskId is not present on this task
    expect(queryByText(/Depends on task ID/i)).toBeNull();
  });

  it('shows dependsOnTaskId as a labeled raw value when present', () => {
    const { getByText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={2}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByText(/Depends on task ID/i)).toBeTruthy();
    expect(getByText(/99/)).toBeTruthy();
  });

  it('shows a counter of "index+1 / total" for a multi-task batch', () => {
    const { getByText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(getByText('1 / 3')).toBeTruthy();
  });

  it('disables the prev arrow (not hides) at the first index and enables next', () => {
    const { getByLabelText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const prev = getByLabelText('Previous task') as HTMLButtonElement;
    const next = getByLabelText('Next task') as HTMLButtonElement;
    expect(prev).toBeTruthy();
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  it('disables the next arrow (not hides) at the last index and enables prev', () => {
    const { getByLabelText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={2}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const prev = getByLabelText('Previous task') as HTMLButtonElement;
    const next = getByLabelText('Next task') as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });

  it('does not render paging arrows for a single-task batch', () => {
    const { queryByLabelText, queryByText } = render(
      <TaskPlannerPreviewDetail
        tasks={[SAMPLE_TASKS[0]]}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(queryByLabelText('Previous task')).toBeNull();
    expect(queryByLabelText('Next task')).toBeNull();
    // No counter either since there's only one task
    expect(queryByText('1 / 1')).toBeNull();
  });

  it('calls onIndexChange with index+1 / index-1 when next/prev clicked', () => {
    const onIndexChange = vi.fn();
    const { getByLabelText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={1}
        onIndexChange={onIndexChange}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(getByLabelText('Next task'));
    expect(onIndexChange).toHaveBeenCalledWith(2);
    fireEvent.click(getByLabelText('Previous task'));
    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('calls onClose when the ✕ button is clicked', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.click(getByLabelText('Close preview'));
    expect(onClose).toHaveBeenCalled();
  });

  it('is not a modal-backdrop overlay (does not block the rest of the modal)', () => {
    const { container } = render(
      <TaskPlannerPreviewDetail
        tasks={SAMPLE_TASKS}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.querySelector('.modal-backdrop')).toBeNull();
  });
});

describe('TaskPlannerPreviewDetail - integrated in TaskPlannerModal', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 40 }) } as any;
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
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

  const BATCH = '```json:task\n[\n  { "title": "Alpha task", "priority": 2, "type": "feature", "description": "Alpha desc" },\n  { "title": "Beta task", "priority": 1, "type": "bug", "description": "Beta desc" }\n]\n```';

  it('clicking a preview TaskCard opens the detail panel showing that task', async () => {
    const { container, getByText, queryByRole } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(40, BATCH);
      await new Promise(r => setTimeout(r, 10));
    });

    // No detail panel initially
    expect(container.querySelector('.task-planner-preview-detail')).toBeNull();

    // Click the first preview card
    const firstCard = container.querySelector('.task-planner-preview .task-card') as HTMLElement;
    expect(firstCard).toBeTruthy();
    await act(async () => {
      firstCard.click();
    });

    // Detail panel now shown for the first task
    expect(container.querySelector('.task-planner-preview-detail')).toBeTruthy();
    expect(getByText('Alpha desc')).toBeTruthy();
    // silence unused var lint
    void queryByRole;
  });

  it('next/prev navigation updates the shown task and ✕ closes the panel', async () => {
    const { container, getByText, getByLabelText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    await act(async () => {
      dispatchAssistantMessage(40, BATCH);
      await new Promise(r => setTimeout(r, 10));
    });

    const firstCard = container.querySelector('.task-planner-preview .task-card') as HTMLElement;
    await act(async () => { firstCard.click(); });

    expect(getByText('Alpha desc')).toBeTruthy();

    // Navigate to next task
    await act(async () => { getByLabelText('Next task').click(); });
    expect(getByText('Beta desc')).toBeTruthy();

    // Navigate back
    await act(async () => { getByLabelText('Previous task').click(); });
    expect(getByText('Alpha desc')).toBeTruthy();

    // Close
    await act(async () => { getByLabelText('Close preview').click(); });
    expect(container.querySelector('.task-planner-preview-detail')).toBeNull();
  });

  it('does not disable or remove the Send or Create buttons while the panel is open', async () => {
    const { container, getByText } = render(<TaskPlannerModal onClose={vi.fn()} onSwitchToManual={vi.fn()} />);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    // Mark ready so Send is only gated on text, not readiness.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-activity', {
        detail: { sessionId: 40, activity: { type: 'idle' } },
      }));
      await new Promise(r => setTimeout(r, 10));
    });

    await act(async () => {
      dispatchAssistantMessage(40, BATCH);
      await new Promise(r => setTimeout(r, 10));
    });

    // Open detail panel
    const firstCard = container.querySelector('.task-planner-preview .task-card') as HTMLElement;
    await act(async () => { firstCard.click(); });

    expect(container.querySelector('.task-planner-preview-detail')).toBeTruthy();

    // Create button must still be present and enabled (parsedTasks is set)
    const createBtn = getByText('Create Tasks') as HTMLButtonElement;
    expect(createBtn).toBeTruthy();
    expect(createBtn.disabled).toBe(false);

    // Send button must still be present. It is only disabled by lack of typed
    // text, not by the panel — assert the panel itself doesn't disable it by
    // typing text and confirming it becomes enabled.
    const sendBtn = getByText('Send') as HTMLButtonElement;
    expect(sendBtn).toBeTruthy();

    const input = container.querySelector('.task-planner-input') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, 'a message while panel open');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Panel still open, and Send is now enabled — the panel did not disable it.
    expect(container.querySelector('.task-planner-preview-detail')).toBeTruthy();
    expect(sendBtn.disabled).toBe(false);
  });
});
