import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

import { SessionsPanel } from '../components/SessionsPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [
      { id: 1, name: 'Session One', agent: 'dev-agent', status: 'running', tabIds: [1], totalCreditsUsed: 0, turnCount: 0 },
      { id: 2, name: 'Session Two', agent: 'reviewer-agent', status: 'stopped', tabIds: [1], totalCreditsUsed: 0, turnCount: 0 },
    ],
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

describe('SessionsPanel - Mobile drill-down (≤480px)', () => {
  let mockMql: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMql = {
      matches: true, // mobile viewport (≤480px)
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mockMql));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on mobile, shows only the session list (detail panel is hidden)', () => {
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The list panel should be visible (no mobile-hidden class)
    const listPanel = container.querySelector('.session-list-panel');
    expect(listPanel).not.toHaveClass('mobile-hidden');

    // The detail panel should be hidden on mobile when no item is drilled into
    const detailPanel = container.querySelector('.session-detail-panel');
    expect(detailPanel).toHaveClass('mobile-hidden');
  });

  it('on mobile, tapping a session item shows the detail view', () => {
    const mockSetActiveSessionId = vi.fn();
    mockUseApp({ activeSessionId: null, setActiveSessionId: mockSetActiveSessionId });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Click on a session item
    fireEvent.click(screen.getByText('Session One'));

    // setActiveSessionId should be called
    expect(mockSetActiveSessionId).toHaveBeenCalledWith(1);
  });

  it('on mobile, when drilled into detail, list panel is hidden and detail is visible', () => {
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Simulate tapping into a session on mobile — click the list item
    const listPanel = container.querySelector('.session-list-panel');
    const listItem = listPanel!.querySelector('.session-item');
    fireEvent.click(listItem!);

    // After drilling in, list should be hidden and detail should be visible
    expect(listPanel).toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.session-detail-panel');
    expect(detailPanel).not.toHaveClass('mobile-hidden');
  });

  it('on mobile detail view, shows a back button', () => {
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Drill into the session
    const listPanel = container.querySelector('.session-list-panel');
    const listItem = listPanel!.querySelector('.session-item');
    fireEvent.click(listItem!);

    // Should show a back button
    const backBtn = container.querySelector('.mobile-back-btn');
    expect(backBtn).toBeInTheDocument();
  });

  it('on mobile, tapping the back button returns to the list view', () => {
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Drill into the session
    const listPanel = container.querySelector('.session-list-panel');
    const listItem = listPanel!.querySelector('.session-item');
    fireEvent.click(listItem!);

    // Click the back button
    const backBtn = container.querySelector('.mobile-back-btn');
    fireEvent.click(backBtn!);

    // List should be visible again, detail should be hidden
    expect(listPanel).not.toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.session-detail-panel');
    expect(detailPanel).toHaveClass('mobile-hidden');
  });

  it('at >480px (desktop), both list and detail are always visible (no drill-down)', () => {
    // Set desktop viewport
    mockMql.matches = false;
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Both panels should be visible (no mobile-hidden class)
    const listPanel = container.querySelector('.session-list-panel');
    expect(listPanel).not.toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.session-detail-panel');
    expect(detailPanel).not.toHaveClass('mobile-hidden');
  });

  it('on mobile, the back button is not rendered at desktop width', () => {
    mockMql.matches = false;
    mockUseApp({ activeSessionId: 1 });
    const { container } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(container.querySelector('.mobile-back-btn')).not.toBeInTheDocument();
  });
});
