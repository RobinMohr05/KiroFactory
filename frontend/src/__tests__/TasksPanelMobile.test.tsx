import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// Mock apiFetch so TaskPlannerModal doesn't make real requests
vi.mock('../utils/api', async () => {
  const actual = await vi.importActual<typeof import('../utils/api')>('../utils/api');
  return {
    ...actual,
    apiFetch: vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 99 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  };
});

const baseMockContext = {
  tasks: [
    { id: 1, title: 'Test task', type: 'bug', priority: 1, state: 'todo', isBlocked: false },
    { id: 2, title: 'Another task', type: 'feature', priority: 2, state: 'in-progress', isBlocked: false },
  ],
  setTasks: vi.fn(),
  currentSort: 'priority' as const,
  setCurrentSort: vi.fn(),
  currentTabId: 1,
  tabs: [{ id: 1, name: 'Test Tab', repositoryUrl: 'https://github.com/test/repo' }],
  fetchTabTasks: vi.fn(),
  pendingOps: { current: new Set() },
  highlightedTaskId: null,
  setHighlightedTaskId: vi.fn(),
};

describe('TasksPanel - mobile view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AppContext.useApp).mockReturnValue(baseMockContext as any);
  });

  it('renders kanban grid on desktop (>480px)', () => {
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(false);
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(container.querySelector('.kanban')).toBeInTheDocument();
    expect(container.querySelector('.mobile-task-list')).not.toBeInTheDocument();
  });

  it('renders MobileTaskList instead of kanban on mobile (≤480px)', () => {
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(true);
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(container.querySelector('.kanban')).not.toBeInTheDocument();
    expect(container.querySelector('.mobile-task-list')).toBeInTheDocument();
  });

  it('opens task modal when a card is tapped on mobile', () => {
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(true);
    render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    // Click on the first visible task card
    const card = screen.getByRole('article', { name: /Test task/i });
    fireEvent.click(card);
    // The TaskModal should now render (it renders when editingTask !== undefined)
    // We check for the modal backdrop / form elements
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('TasksPanel - + Task button behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AppContext.useApp).mockReturnValue(baseMockContext as any);
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(false);
  });

  it('clicking + Task opens the TaskPlannerModal, not TaskModal', () => {
    render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const newTaskBtn = document.getElementById('newTaskBtn')!;
    fireEvent.click(newTaskBtn);
    // TaskPlannerModal renders with a title "AI Task Planner"
    expect(screen.getByText('AI Task Planner')).toBeInTheDocument();
  });

  it('does not render a separate #aiPlannerBtn', () => {
    render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(document.getElementById('aiPlannerBtn')).toBeNull();
  });
});
