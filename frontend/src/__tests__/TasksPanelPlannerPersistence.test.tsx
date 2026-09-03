import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { act } from 'react';
import { TasksPanel } from '../components/TasksPanel';
import * as AppContext from '../context/AppContext';
import * as MobileBreakpoint from '../hooks/useMobileBreakpoint';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../hooks/useMobileBreakpoint', () => ({
  useMobileBreakpoint: vi.fn(),
}));

vi.mock('../utils/api', async () => {
  const actual = await vi.importActual<typeof import('../utils/api')>('../utils/api');
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const baseMockContext = {
  tasks: [],
  setTasks: vi.fn(),
  currentSort: 'priority' as const,
  setCurrentSort: vi.fn(),
  currentTabId: 1,
  tabs: [{ id: 1, name: 'Test Tab' }],
  fetchTabTasks: vi.fn(),
  pendingOps: { current: new Set() },
  highlightedTaskId: null,
  setHighlightedTaskId: vi.fn(),
};

describe('TasksPanel - planner session persistence (approach A)', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiFetchMock = vi.mocked(api.apiFetch);
    vi.mocked(AppContext.useApp).mockReturnValue(baseMockContext as any);
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('reopening + Task after an outside-click dismiss keeps the same session (no new /start, no DELETE)', async () => {
    let startCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        startCount++;
        return { ok: true, json: async () => ({ sessionId: 900 }) };
      }
      if (opts?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    });

    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);

    // Open the planner.
    const newTaskBtn = container.querySelector('#newTaskBtn') as HTMLButtonElement;
    await act(async () => {
      newTaskBtn.click();
      await new Promise(r => setTimeout(r, 10));
    });
    expect(startCount).toBe(1);

    // Dismiss via backdrop click.
    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });

    // Backdrop hides but does not DELETE.
    expect(backdrop.hasAttribute('hidden')).toBe(true);
    let deleteCalls = apiFetchMock.mock.calls.filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(0);

    // Reopen via + Task — should resume, not start a new session.
    await act(async () => {
      newTaskBtn.click();
      await new Promise(r => setTimeout(r, 10));
    });

    expect(startCount).toBe(1); // still only one /start
    expect(backdrop.hasAttribute('hidden')).toBe(false); // un-hidden
    deleteCalls = apiFetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls.length).toBe(0);
  });
});
