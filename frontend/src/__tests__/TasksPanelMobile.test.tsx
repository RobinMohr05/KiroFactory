import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TasksPanel } from '../components/TasksPanel';
import * as AppContext from '../context/AppContext';
import * as MobileBreakpoint from '../hooks/useMobileBreakpoint';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../hooks/useMobileBreakpoint', () => ({
  useMobileBreakpoint: vi.fn(),
}));

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
  boardSessions: [],
  boardAgents: [],
  setActiveSessionId: vi.fn(),
  setActiveView: vi.fn(),
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
    const { container } = render(<TasksPanel />);
    expect(container.querySelector('.kanban')).toBeInTheDocument();
    expect(container.querySelector('.mobile-task-list')).not.toBeInTheDocument();
  });

  it('renders MobileTaskList instead of kanban on mobile (≤480px)', () => {
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(true);
    const { container } = render(<TasksPanel />);
    expect(container.querySelector('.kanban')).not.toBeInTheDocument();
    expect(container.querySelector('.mobile-task-list')).toBeInTheDocument();
  });

  it('opens task modal when a card is tapped on mobile', () => {
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(true);
    render(<TasksPanel />);
    // Click on the first visible task card
    const card = screen.getByRole('article', { name: /Test task/i });
    fireEvent.click(card);
    // The TaskModal should now render (it renders when editingTask !== undefined)
    // We check for the modal backdrop / form elements
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
