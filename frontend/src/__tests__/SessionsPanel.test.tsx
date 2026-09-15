import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock('../components/AutoScalerPanel', () => ({
  AutoScalerPanel: () => <div data-testid="autoscaler-panel">AutoScalerPanel</div>,
  AutoScalerDetailView: ({ autoScaler }: { autoScaler: { name: string } }) => (
    <div data-testid="autoscaler-detail-panel">{autoScaler.name}</div>
  ),
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

describe('SessionsPanel - Looper mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render #newSessionBtn in looper mode', () => {
    mockUseApp({
      user: { uiViewMode: 'looper' } as any,
      sessions: [{
        id: 1,
        name: 'Chat',
        agent: '',
        status: 'stopped',
        pinned: true,
        isPermanent: true,
        tabIds: [1],
      }],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByText('+ New Session')).not.toBeInTheDocument();
  });

  it('does not render #sessionList (unpinned sessions) in looper mode', () => {
    mockUseApp({
      user: { uiViewMode: 'looper' } as any,
      sessions: [
        {
          id: 1,
          name: 'Chat',
          agent: '',
          status: 'stopped',
          pinned: true,
          isPermanent: true,
          tabIds: [1],
        },
        {
          id: 2,
          name: 'Unpinned Session',
          agent: 'developer-agent',
          status: 'stopped',
          pinned: false,
          isPermanent: false,
          tabIds: [1],
        },
      ],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The unpinned session list should not be rendered at all
    expect(document.getElementById('sessionList')).not.toBeInTheDocument();
    // The unpinned session should not appear anywhere
    expect(screen.queryByText('Unpinned Session')).not.toBeInTheDocument();
  });

  it('only shows isPermanent sessions in the pinned list in looper mode', () => {
    mockUseApp({
      user: { uiViewMode: 'looper' } as any,
      sessions: [
        {
          id: 1,
          name: 'Chat',
          agent: '',
          status: 'stopped',
          pinned: true,
          isPermanent: true,
          tabIds: [1],
        },
        {
          id: 2,
          name: 'Pinned Agent',
          agent: 'developer-agent',
          status: 'stopped',
          pinned: true,
          isPermanent: false,
          tabIds: [1],
        },
      ],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The permanent+pinned session should be visible
    expect(screen.getAllByText('Chat').length).toBeGreaterThanOrEqual(1);
    // The pinned-but-not-permanent session should NOT be visible in looper mode
    expect(screen.queryByText('Pinned Agent')).not.toBeInTheDocument();
  });
});

describe('SessionsPanel - Advanced mode regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders #newSessionBtn, full pinned list, and full unpinned list in advanced mode', () => {
    mockUseApp({
      user: { uiViewMode: 'advanced' } as any,
      sessions: [
        {
          id: 1,
          name: 'Permanent Chat',
          agent: '',
          status: 'stopped',
          pinned: true,
          isPermanent: true,
          tabIds: [1],
        },
        {
          id: 2,
          name: 'Pinned Agent',
          agent: 'developer-agent',
          status: 'stopped',
          pinned: true,
          isPermanent: false,
          tabIds: [1],
        },
        {
          id: 3,
          name: 'Unpinned Session',
          agent: 'developer-agent',
          status: 'stopped',
          pinned: false,
          isPermanent: false,
          tabIds: [1],
        },
      ],
      activeSessionId: 1,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Button should be present
    expect(screen.getByText('+ New Session')).toBeInTheDocument();
    // All sessions should be visible (pinned + unpinned)
    expect(screen.getAllByText('Permanent Chat').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Pinned Agent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Unpinned Session').length).toBeGreaterThanOrEqual(1);
    // Unpinned session list should be rendered
    expect(document.getElementById('sessionList')).toBeInTheDocument();
  });
});

describe('SessionsPanel - Card Start/Stop buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as any);
  });

  it('shows a Start button (not Stop) on a stopped session card', () => {
    mockUseApp({
      sessions: [{ id: 5, name: 'Idle Session', agent: 'developer-agent', status: 'stopped', tabIds: [1] }],
      activeSessionId: 5,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="5"]') as HTMLElement;
    expect(item).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /^start$/i })).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument();
  });

  it('shows a Stop button (not Start) on a running session card', () => {
    mockUseApp({
      sessions: [{ id: 6, name: 'Live Session', agent: 'developer-agent', status: 'running', tabIds: [1] }],
      activeSessionId: 6,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="6"]') as HTMLElement;
    expect(within(item).getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
  });

  it('clicking Start calls the existing start endpoint for that session without selecting the card', async () => {
    const setActiveSessionId = vi.fn();
    mockUseApp({
      sessions: [{ id: 7, name: 'Idle Session', agent: 'developer-agent', status: 'stopped', tabIds: [1] }],
      activeSessionId: 99,
      setActiveSessionId,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="7"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: /^start$/i }));

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/sessions/7/start', { method: 'POST' });
    });
    // Clicking the button must not trigger card selection/navigation.
    expect(setActiveSessionId).not.toHaveBeenCalledWith(7);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking Stop calls the existing stop endpoint for that session', async () => {
    mockUseApp({
      sessions: [{ id: 8, name: 'Live Session', agent: 'developer-agent', status: 'running', tabIds: [1] }],
      activeSessionId: 8,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="8"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: /^stop$/i }));

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/sessions/8/stop', { method: 'POST' });
    });
  });

  it('shows a pending label and disables the button while a start is in flight', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    vi.mocked(api.apiFetch).mockImplementation((url: string) => {
      if (url.endsWith('/start')) {
        return new Promise((resolve) => { resolveFetch = resolve; }) as any;
      }
      return Promise.resolve({ ok: true, json: async () => [] }) as any;
    });

    mockUseApp({
      sessions: [{ id: 9, name: 'Idle Session', agent: 'developer-agent', status: 'stopped', tabIds: [1] }],
      activeSessionId: 9,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="9"]') as HTMLElement;
    const startBtn = within(item).getByRole('button', { name: /^start$/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      const pendingBtn = within(item).getByRole('button', { name: /starting/i });
      expect(pendingBtn).toBeDisabled();
    });

    resolveFetch({ ok: true, json: async () => [] });
  });

  it('clears the pending label after a successful start once the session status updates to running', async () => {
    mockUseApp({
      sessions: [{ id: 11, name: 'Idle Session', agent: 'developer-agent', status: 'stopped', tabIds: [1] }],
      activeSessionId: 11,
    });
    const { rerender } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = () => document.querySelector('.session-item[data-session-id="11"]') as HTMLElement;
    fireEvent.click(within(item()).getByRole('button', { name: /^start$/i }));

    await waitFor(() => {
      expect(within(item()).getByRole('button', { name: /starting/i })).toBeInTheDocument();
    });

    // Simulate the WS `session-updated` event flipping the session to running.
    mockUseApp({
      sessions: [{ id: 11, name: 'Idle Session', agent: 'developer-agent', status: 'running', tabIds: [1] }],
      activeSessionId: 11,
    });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await waitFor(() => {
      expect(within(item()).getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    });
    expect(within(item()).queryByRole('button', { name: /starting/i })).not.toBeInTheDocument();
  });

  it('reverts the button to its prior state when the action fails', async () => {
    vi.mocked(api.apiFetch).mockImplementation((url: string) => {
      if (url.endsWith('/start')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) as any;
      }
      return Promise.resolve({ ok: true, json: async () => [] }) as any;
    });

    mockUseApp({
      sessions: [{ id: 10, name: 'Idle Session', agent: 'developer-agent', status: 'stopped', tabIds: [1] }],
      activeSessionId: 10,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    const item = document.querySelector('.session-item[data-session-id="10"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: /^start$/i }));

    // After the failed request resolves, the button must not be stuck in a
    // pending state — it reverts to the plain Start button.
    await waitFor(() => {
      expect(within(item).getByRole('button', { name: /^start$/i })).toBeInTheDocument();
      expect(within(item).getByRole('button', { name: /^start$/i })).not.toBeDisabled();
    });
    expect(within(item).queryByRole('button', { name: /starting/i })).not.toBeInTheDocument();
  });
});
