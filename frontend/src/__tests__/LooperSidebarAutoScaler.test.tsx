/**
 * Tests for the Looper-mode sidebar improvements:
 * - View dropdown (Auto-Scalers / Scheduled Sessions)
 * - localStorage persistence of the dropdown selection
 * - Compact AutoScalerCard (name + running indicator + Start/Stop)
 * - Auto-scaler detail view in the right panel
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

const STORAGE_KEY = 'vch.looperSidebarView';

const baseAutoScaler = {
  id: 10,
  name: 'My Scaler',
  userId: 1,
  agentName: 'developer-agent',
  tabIds: [1],
  maxConcurrency: 5,
  idleTimeoutSeconds: 30,
  status: 'stopped' as const,
  createdAt: '2026-01-01T00:00:00Z',
  runningSessionCount: 0,
};

const runningAutoScaler = {
  ...baseAutoScaler,
  id: 11,
  name: 'Running Scaler',
  status: 'running' as const,
  runningSessionCount: 3,
};

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [],
    setSessions: vi.fn(),
    currentTabId: 1,
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    tabs: [{ id: 1, name: 'VCH' }, { id: 2, name: 'Other' }],
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

describe('LooperSidebar - view dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the view dropdown in looper mode', () => {
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    expect(dropdown).toBeInTheDocument();
  });

  it('dropdown has Auto-Scalers and Scheduled Sessions options', () => {
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    const options = Array.from((dropdown as HTMLSelectElement).options).map(o => o.value);
    expect(options).toContain('autoscalers');
    expect(options).toContain('scheduled');
  });

  it('defaults to autoscalers when localStorage is empty', () => {
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i }) as HTMLSelectElement;
    expect(dropdown.value).toBe('autoscalers');
  });

  it('persists dropdown selection to localStorage', () => {
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    fireEvent.change(dropdown, { target: { value: 'scheduled' } });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('scheduled');
  });

  it('reads persisted selection from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'scheduled');
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i }) as HTMLSelectElement;
    expect(dropdown.value).toBe('scheduled');
  });

  it('defaults to autoscalers when localStorage has an invalid value', () => {
    localStorage.setItem(STORAGE_KEY, 'invalid');
    mockUseApp();
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i }) as HTMLSelectElement;
    expect(dropdown.value).toBe('autoscalers');
  });

  it('does NOT render the dropdown in non-looper modes', () => {
    mockUseApp({ user: { id: 1, email: 'test@example.com', createdAt: '2026-01-01', uiViewMode: 'advanced' as const } });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    expect(screen.queryByRole('combobox', { name: /sidebar view/i })).not.toBeInTheDocument();
  });
});

describe('LooperSidebar - section visibility based on dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows autoscaler section and hides scheduled section when autoscalers is selected', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    // autoscaler panel visible
    expect(screen.getByTestId('autoscaler-panel')).toBeInTheDocument();
    // scheduled session button hidden
    expect(screen.queryByText('+ Scheduled Session')).not.toBeInTheDocument();
    // scheduled session list hidden
    expect(document.getElementById('scheduledSessionList')).not.toBeInTheDocument();
  });

  it('shows scheduled section and hides autoscaler section when scheduled is selected', () => {
    localStorage.setItem(STORAGE_KEY, 'scheduled');
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    // scheduled button visible
    expect(screen.getByText('+ Scheduled Session')).toBeInTheDocument();
    // autoscaler panel hidden
    expect(screen.queryByTestId('autoscaler-panel')).not.toBeInTheDocument();
  });

  it('switches sections when dropdown changes', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Initially autoscalers
    expect(screen.getByTestId('autoscaler-panel')).toBeInTheDocument();
    expect(screen.queryByText('+ Scheduled Session')).not.toBeInTheDocument();

    // Switch to scheduled
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    fireEvent.change(dropdown, { target: { value: 'scheduled' } });

    expect(screen.queryByTestId('autoscaler-panel')).not.toBeInTheDocument();
    expect(screen.getByText('+ Scheduled Session')).toBeInTheDocument();
  });
});

describe('AutoScalerCard compact form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows only name, status indicator, Start and Stop in compact card', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Name visible
    expect(screen.getByText('My Scaler')).toBeInTheDocument();
    // Start/Stop buttons
    expect(screen.getByRole('button', { name: /^start$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    // Agent, max concurrency, running count NOT in compact card
    expect(screen.queryByText(/Agent:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Max:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Running:/)).not.toBeInTheDocument();
    // Delete NOT in compact card
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('status dot reflects running state', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    // The running scaler card should have a running indicator
    const card = document.querySelector('[data-autoscaler-id="11"]');
    expect(card).toBeInTheDocument();
    const dot = card!.querySelector('.autoscaler-status-dot');
    expect(dot).toBeInTheDocument();
    expect(dot!.className).toContain('autoscaler-status-dot--running');
  });

  it('Start is disabled when running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const startBtn = screen.getByRole('button', { name: /^start$/i });
    expect(startBtn).toBeDisabled();
  });

  it('Stop is disabled when stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const stopBtn = screen.getByRole('button', { name: /^stop$/i });
    expect(stopBtn).toBeDisabled();
  });
});

describe('AutoScaler selection and detail view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('selecting an autoscaler card renders detail in the right panel', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Click the card to select
    const card = document.querySelector('[data-autoscaler-id="10"]');
    expect(card).toBeInTheDocument();
    fireEvent.click(card!);

    // Right panel should now show detail
    const detail = screen.getByTestId('autoscaler-detail-panel');
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent('My Scaler');
  });

  it('detail shows all fields: agent, tabs, model, maxConcurrency, idleTimeoutSeconds, createdAt', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Agent
    expect(detail).toHaveTextContent('developer-agent');
    // Tabs (resolved to name)
    expect(detail).toHaveTextContent('VCH');
    // Model (unset = "auto")
    expect(detail).toHaveTextContent('auto');
    // maxConcurrency (5)
    expect(detail).toHaveTextContent('5');
    // idleTimeoutSeconds
    expect(detail).toHaveTextContent('30');
  });

  it('detail shows ∞ for maxConcurrency when 0', () => {
    mockUseApp({ autoScalers: [{ ...baseAutoScaler, maxConcurrency: 0 }] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    expect(detail).toHaveTextContent('∞');
  });

  it('switching to scheduled view restores session detail panel', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Select an autoscaler
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);
    expect(screen.getByTestId('autoscaler-detail-panel')).toBeInTheDocument();

    // Switch to scheduled view
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    fireEvent.change(dropdown, { target: { value: 'scheduled' } });

    // Autoscaler detail should no longer appear
    expect(screen.queryByTestId('autoscaler-detail-panel')).not.toBeInTheDocument();
  });
});

describe('AutoScaler detail view — edit form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows edit form in detail when stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Name input
    expect(detail.querySelector('input[name="name"]') || detail.querySelector('#editAutoScalerName')).toBeTruthy();
    // Save button
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('edit inputs are disabled when auto-scaler is running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const nameInput = detail.querySelector('#editAutoScalerName') as HTMLInputElement;
    expect(nameInput).toBeDisabled();

    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();
  });

  it('shows "stop it first" hint when running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    expect(detail).toHaveTextContent(/stop.*first/i);
  });

  it('Delete button is present in detail view when stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('Delete button is disabled when running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('calls PATCH with edited fields on save', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const nameInput = document.getElementById('editAutoScalerName') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Updated Scaler' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    // Wait for async save
    await vi.waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/autoscalers/10',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('Updated Scaler'),
        })
      );
    });
  });

  it('shows inline error message on failed save', async () => {
    const { apiFetch } = await import('../utils/api');
    // Make all apiFetch calls return ok: true by default, then override with mockImplementation
    // that returns failure on the PATCH call specifically
    vi.mocked(apiFetch).mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        return { ok: false, json: async () => ({ error: 'Name already taken' }) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    // Change the name so the patch body is non-empty (empty patches are skipped)
    const nameInput = document.getElementById('editAutoScalerName') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Different Name' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await screen.findByText('Name already taken');
  });
});
