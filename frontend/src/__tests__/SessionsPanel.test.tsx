import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
  };
});

// We need to import SessionsPanel after mocks are set up
import { SessionsPanel } from '../components/SessionsPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [],
    setSessions: vi.fn(),
    currentTabId: 1,
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    tabs: [{ id: 1, name: 'Test Tab' }],
    pendingOps: { current: new Set() },
    errors: [],
    tasks: [],
    setActiveView: vi.fn(),
    setHighlightedTaskId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('SessionsPanel - Sidebar list item enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows current task ID and truncated title when session is working on a task', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        currentTaskId: 142,
        currentTaskTitle: 'Add report_verdict MCP tool for no further stage needed signal with diff cross-check',
        totalCreditsUsed: 0.5,
        turnCount: 3,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Should show task ID in both the sidebar item and the detail header
    const taskIdElements = screen.getAllByText(/#142/);
    expect(taskIdElements.length).toBeGreaterThanOrEqual(1);
    // Sidebar should have the truncated task title (shown in both places)
    const taskElements = screen.getAllByText(/Add report_verdict MCP tool/);
    expect(taskElements.length).toBeGreaterThanOrEqual(1);
    // The sidebar version should be truncated (30 chars + ellipsis)
    const sidebarTaskEl = taskElements.find(el => el.classList.contains('session-item-task'));
    expect(sidebarTaskEl).toBeDefined();
  });

  it('shows error indicator when session has errors', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 1.0,
        tabIds: [1],
      }],
      activeSessionId: 1,
      errors: [
        { id: 'e1', message: 'Something failed', context: '', agent: 'developer-agent', sessionName: 'Dev Agent', timestamp: '2026-08-15T10:00:00Z', taskCreated: false },
      ],
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Should show an error indicator in the sidebar item
    const errorIndicator = screen.getByTestId('session-error-indicator-1');
    expect(errorIndicator).toBeInTheDocument();
  });

  it('does NOT show error indicator when session has no errors', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 1.0,
        tabIds: [1],
      }],
      activeSessionId: 1,
      errors: [],
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByTestId('session-error-indicator-1')).not.toBeInTheDocument();
  });

  it('shows credits with EUR value in sidebar item', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 0.35,
        tabIds: [1],
        turnCount: 1,
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Should show credits with EUR in the sidebar item (may also appear in detail header)
    const creditElements = screen.getAllByText(/0\.35/);
    expect(creditElements.length).toBeGreaterThanOrEqual(1);
    // Should show EUR conversion (0.35 * 0.04 = 0.014)
    const eurElements = screen.getAllByText(/€0\.014/);
    expect(eurElements.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show task info when session is not working on a task', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 0.5,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByText(/#\d+/)).not.toBeInTheDocument();
  });
});

describe('SessionsPanel - Session detail header enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows turn count in the session detail header', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 2.5,
        turnCount: 7,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Should show turn count
    expect(screen.getByText(/7 turns/i)).toBeInTheDocument();
  });

  it('shows current task as a clickable element with onClick handler', () => {
    const mockSetHighlightedTaskId = vi.fn();
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        currentTaskId: 42,
        currentTaskTitle: 'Fix the login bug',
        totalCreditsUsed: 1.0,
        turnCount: 3,
        tabIds: [1],
      }],
      activeSessionId: 1,
      setHighlightedTaskId: mockSetHighlightedTaskId,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const taskLink = screen.getByTestId('session-current-task-link');
    expect(taskLink).toBeInTheDocument();

    // The task link should have an onClick handler and be keyboard accessible
    taskLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('/tasks');
    expect(mockSetHighlightedTaskId).toHaveBeenCalledWith(42);
  });

  it('shows total credits in the session detail header', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 2.5,
        turnCount: 7,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The detail header should show total credits with EUR
    const detailHeader = screen.getByTestId('session-detail-meta');
    expect(detailHeader).toHaveTextContent(/2\.50/);
    expect(detailHeader).toHaveTextContent(/€0\.100/);
  });

  it('shows current task as a clickable link in the session detail header', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        currentTaskId: 42,
        currentTaskTitle: 'Fix the login bug',
        totalCreditsUsed: 1.0,
        turnCount: 3,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Should show task link in detail header
    const taskLink = screen.getByTestId('session-current-task-link');
    expect(taskLink).toBeInTheDocument();
    expect(taskLink).toHaveTextContent('#42');
    expect(taskLink).toHaveTextContent('Fix the login bug');
  });

  it('does not show turn count section when turnCount is 0', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'stopped',
        totalCreditsUsed: 0,
        turnCount: 0,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByTestId('session-detail-meta')).not.toBeInTheDocument();
  });

  it('does not show current task link when no task is active', () => {
    mockUseApp({
      sessions: [{
        id: 1,
        name: 'Dev Agent',
        agent: 'developer-agent',
        status: 'running',
        totalCreditsUsed: 1.0,
        turnCount: 3,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByTestId('session-current-task-link')).not.toBeInTheDocument();
  });
});
