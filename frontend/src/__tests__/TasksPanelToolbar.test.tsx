import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksPanel } from '../components/TasksPanel';
import * as AppContext from '../context/AppContext';
import * as MobileBreakpoint from '../hooks/useMobileBreakpoint';

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
    apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  };
});

const baseMockContext = {
  tasks: [],
  setTasks: vi.fn(),
  currentSort: 'priority' as const,
  setCurrentSort: vi.fn(),
  currentTabId: 1,
  // A tab WITH a repositoryUrl — the toolbar must still not render a repo link.
  tabs: [{ id: 1, name: 'Test Tab', repositoryUrl: 'https://github.com/test/repo' }],
  fetchTabTasks: vi.fn(),
  pendingOps: { current: new Set() },
  highlightedTaskId: null,
  setHighlightedTaskId: vi.fn(),
};

describe('TasksPanel - toolbar layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AppContext.useApp).mockReturnValue(baseMockContext as any);
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(false);
  });

  it('does not render the repository link / repo indicator in the toolbar', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(container.querySelector('.board-repo-indicator')).toBeNull();
    expect(container.querySelector('.toolbar a')).toBeNull();
  });

  it('groups Sort and Reload in a right-aligned .toolbar-right wrapper', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const right = container.querySelector('.toolbar-right');
    expect(right).not.toBeNull();
    // Sort first, then Reload, both inside the wrapper.
    expect(right!.querySelector('#taskSortSelect')).not.toBeNull();
    expect(right!.querySelector('#refreshTasksBtn')).not.toBeNull();
    const children = Array.from(right!.children);
    expect(children[0].id).toBe('taskSortSelect');
    expect(children[1].id).toBe('refreshTasksBtn');
  });

  it('keeps + Task on the far left, outside .toolbar-right', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const toolbar = container.querySelector('.toolbar')!;
    expect(toolbar.firstElementChild!.id).toBe('newTaskBtn');
    expect(container.querySelector('.toolbar-right #newTaskBtn')).toBeNull();
  });
});
