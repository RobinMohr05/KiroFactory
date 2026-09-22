/**
 * Tests for scoping the auto-scaler list to the currently active tab (task #1825).
 *
 * The AutoScalerPanel should only render auto-scalers whose `tabIds` includes the
 * current tab id. Switching tabs should re-scope the list, and selecting an
 * auto-scaler then switching to a tab it doesn't belong to should clear the
 * detail-panel selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';

// ---- Mocks ----

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock('../components/ModelSelect', () => ({
  ModelSelect: ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => (
    <input
      id={id}
      type="text"
      role="combobox"
      data-testid="model-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
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

// Import after mocks
import { SessionsPanel } from '../components/SessionsPanel';

const tecFactoryScaler = {
  id: 10,
  name: 'TecFactory Scaler',
  userId: 1,
  agentName: 'developer-agent',
  tabIds: [1],
  maxConcurrency: 5,
  idleTimeoutSeconds: 30,
  status: 'stopped' as const,
  createdAt: '2026-01-01T00:00:00Z',
  runningSessionCount: 0,
};

const idpInScaler = {
  ...tecFactoryScaler,
  id: 11,
  name: 'IDP_IN Scaler',
  tabIds: [2],
};

const multiTabScaler = {
  ...tecFactoryScaler,
  id: 12,
  name: 'Multi Tab Scaler',
  tabIds: [1, 2],
};

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [],
    setSessions: vi.fn(),
    currentTabId: 1,
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    tabs: [{ id: 1, name: 'TecFactory' }, { id: 2, name: 'IDP_IN' }],
    pendingOps: { current: new Set() },
    errors: [],
    tasks: [],
    setActiveView: vi.fn(),
    setHighlightedTaskId: vi.fn(),
    agents: [{ id: 1, name: 'developer-agent', prompt: '', description: '' }],
    autoScalers: [],
    setAutoScalers: vi.fn(),
    fetchAutoScalers: vi.fn().mockResolvedValue(undefined),
    user: { id: 1, email: 'test@example.com', createdAt: '2026-01-01', uiViewMode: 'looper' as const },
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('AutoScalerPanel — tab scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows only auto-scalers for the current tab (TecFactory)', () => {
    mockUseApp({ currentTabId: 1, autoScalers: [tecFactoryScaler, idpInScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.getByText('TecFactory Scaler')).toBeInTheDocument();
    expect(screen.queryByText('IDP_IN Scaler')).not.toBeInTheDocument();
  });

  it('shows only auto-scalers for the current tab (IDP_IN)', () => {
    mockUseApp({ currentTabId: 2, autoScalers: [tecFactoryScaler, idpInScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.getByText('IDP_IN Scaler')).toBeInTheDocument();
    expect(screen.queryByText('TecFactory Scaler')).not.toBeInTheDocument();
  });

  it('shows a multi-tab auto-scaler on all of its tabs', () => {
    // On tab 1
    const ctx1 = mockUseApp({ currentTabId: 1, autoScalers: [multiTabScaler] });
    const { unmount } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    expect(screen.getByText('Multi Tab Scaler')).toBeInTheDocument();
    unmount();

    // On tab 2
    void ctx1;
    mockUseApp({ currentTabId: 2, autoScalers: [multiTabScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    expect(screen.getByText('Multi Tab Scaler')).toBeInTheDocument();
  });

  it('shows the empty-state hint when no auto-scaler matches the current tab', () => {
    mockUseApp({ currentTabId: 2, autoScalers: [tecFactoryScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByText('IDP_IN Scaler')).not.toBeInTheDocument();
    expect(screen.getByText(/No auto-scalers yet/i)).toBeInTheDocument();
  });

  it('clears the selected auto-scaler when switching to a tab it does not belong to', () => {
    mockUseApp({ currentTabId: 1, autoScalers: [tecFactoryScaler, idpInScaler] });
    const { rerender } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Select the TecFactory scaler (tab 1)
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);
    expect(screen.getByTestId('autoscaler-detail-panel')).toBeInTheDocument();

    // Switch to tab 2 — the selected scaler is no longer visible, so the detail
    // panel selection must be cleared.
    mockUseApp({ currentTabId: 2, autoScalers: [tecFactoryScaler, idpInScaler] });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.queryByTestId('autoscaler-detail-panel')).not.toBeInTheDocument();
  });

  it('keeps the selected multi-tab auto-scaler selected when switching between its tabs', () => {
    mockUseApp({ currentTabId: 1, autoScalers: [multiTabScaler] });
    const { rerender } = render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    fireEvent.click(document.querySelector('[data-autoscaler-id="12"]')!);
    expect(screen.getByTestId('autoscaler-detail-panel')).toBeInTheDocument();

    // Switch to tab 2 — the scaler covers tab 2 too, so it stays selected.
    mockUseApp({ currentTabId: 2, autoScalers: [multiTabScaler] });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    expect(screen.getByTestId('autoscaler-detail-panel')).toBeInTheDocument();
  });
});
