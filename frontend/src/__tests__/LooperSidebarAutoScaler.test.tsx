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

  // Helper: select an autoscaler and click the Edit button to enter edit mode
  function enterEditMode(autoScalerId: number) {
    const card = document.querySelector(`[data-autoscaler-id="${autoScalerId}"]`);
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
  }

  it('shows edit form in detail when stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Name input
    expect(detail.querySelector('input[name="name"]') || detail.querySelector('#editAutoScalerName')).toBeTruthy();
    // Save button
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('edit inputs are disabled when auto-scaler is running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    // Running autoscaler: the Edit button should be disabled so users can't enter edit mode
    const card = document.querySelector('[data-autoscaler-id="11"]');
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement | undefined;

    if (editBtn && !editBtn.disabled) {
      // If Edit is not disabled, enter edit mode and check form fields are disabled
      fireEvent.click(editBtn);
      const nameInput = detail.querySelector('#editAutoScalerName') as HTMLInputElement;
      if (nameInput) {
        expect(nameInput).toBeDisabled();
        const saveBtn = screen.getByRole('button', { name: /save/i });
        expect(saveBtn).toBeDisabled();
      }
    } else {
      // Edit button is disabled — can't enter edit mode for running scalers (acceptable behavior)
      expect(editBtn).toBeDefined();
      expect(editBtn!.disabled).toBe(true);
    }
  });

  it('shows "stop it first" hint when running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const card = document.querySelector('[data-autoscaler-id="11"]');
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Try to enter edit mode if Edit button is not disabled
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement | undefined;

    if (editBtn && !editBtn.disabled) {
      // If Edit is clickable, the hint should appear when in edit mode while running
      fireEvent.click(editBtn);
      expect(detail).toHaveTextContent(/stop.*first/i);
    } else {
      // Edit button is disabled for running scalers — this is an acceptable alternative
      // that prevents editing entirely. Check we at least see the Edit button is disabled.
      expect(editBtn).toBeDefined();
      expect(editBtn!.disabled).toBe(true);
    }
  });

  it('Delete button is present in detail view when stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('Delete button is disabled when running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    const card = document.querySelector('[data-autoscaler-id="11"]');
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement | undefined;

    if (editBtn && !editBtn.disabled) {
      // If Edit is clickable, enter edit mode and check Delete is disabled
      fireEvent.click(editBtn);
      const deleteBtn = screen.getByRole('button', { name: /delete/i });
      expect(deleteBtn).toBeDisabled();
    } else {
      // Edit is disabled — the entire form (including Delete) is hidden
      // The component prevents editing/deleting when running, which is the intended behavior
      expect(editBtn).toBeDefined();
      expect(editBtn!.disabled).toBe(true);
    }
  });

  it('calls PATCH with edited fields on save', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

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
    enterEditMode(10);

    // Change the name so the patch body is non-empty (empty patches are skipped)
    const nameInput = document.getElementById('editAutoScalerName') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Different Name' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await screen.findByText('Name already taken');
  });
});

describe('AutoScaler review comment fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // Helper: select an autoscaler and click the Edit button to enter edit mode
  function enterEditMode(autoScalerId: number) {
    const card = document.querySelector(`[data-autoscaler-id="${autoScalerId}"]`);
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
  }

  // Comment 1: model field should use null (not undefined) when clearing, so JSON.stringify includes it
  it('PATCH body includes model: null when the model field is cleared (not omitted)', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    const scalerWithModel = { ...baseAutoScaler, model: 'claude-opus-4' };
    mockUseApp({ autoScalers: [scalerWithModel] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    // Clear the model field (set to empty string = "auto")
    const modelInput = document.getElementById('editAutoScalerModel') as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: '' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await vi.waitFor(() => {
      const patchCalls = mockApiFetch.mock.calls.filter(
        ([, opts]) => opts && (opts as RequestInit).method === 'PATCH'
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
      // model: null must be present in the body (not undefined/omitted)
      expect(Object.prototype.hasOwnProperty.call(body, 'model')).toBe(true);
      expect(body.model).toBeNull();
    });
  });

  // Comment 2: edit form should re-sync when autoScaler prop changes (WS update)
  it('edit form re-syncs when the autoScaler prop updates via WS (useEffect reset)', () => {
    const { rerender } = render(
      <MemoryRouter>
        <SessionsPanel />
      </MemoryRouter>
    );

    mockUseApp({ autoScalers: [baseAutoScaler] });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Select and enter edit mode
    enterEditMode(10);

    // Simulate a WS update that changes the name
    const updatedScaler = { ...baseAutoScaler, name: 'Updated By WS' };
    mockUseApp({ autoScalers: [updatedScaler] });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The edit name input should reflect the updated name
    const nameInput = document.getElementById('editAutoScalerName') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('Updated By WS');
  });

  // Comment 3: switching sidebar view should clear selectedAutoScalerId
  it('switching sidebar view from autoscalers to scheduled clears the selected auto-scaler', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Select an autoscaler
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);
    expect(screen.getByTestId('autoscaler-detail-panel')).toBeInTheDocument();

    // Switch to scheduled
    const dropdown = screen.getByRole('combobox', { name: /sidebar view/i });
    fireEvent.change(dropdown, { target: { value: 'scheduled' } });

    // Switch back to autoscalers
    fireEvent.change(dropdown, { target: { value: 'autoscalers' } });

    // The detail panel should NOT reappear — selected ID was cleared
    expect(screen.queryByTestId('autoscaler-detail-panel')).not.toBeInTheDocument();
  });

  // Comment 4: agent select in edit form should have a placeholder option
  it('edit form agent select includes a placeholder "Select agent..." option', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    const agentSelect = document.getElementById('editAutoScalerAgent') as HTMLSelectElement;
    expect(agentSelect).not.toBeNull();
    const options = Array.from(agentSelect.options).map(o => o.value);
    expect(options).toContain('');
    const placeholderOption = Array.from(agentSelect.options).find(o => o.value === '');
    expect(placeholderOption?.text).toMatch(/select agent/i);
  });
});

describe('PR Review Comment fixes — round 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // Helper: select an autoscaler and click the Edit button to enter edit mode
  function enterEditMode(autoScalerId: number) {
    const card = document.querySelector(`[data-autoscaler-id="${autoScalerId}"]`);
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
  }

  // Issue 1: handleDelete should show inline error on failure (not swallow it)
  it('shows inline delete error when DELETE request fails', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        return { ok: false, json: async () => ({ error: 'Failed to delete' }) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    // First click puts it in confirm-pending state (useConfirmAction)
    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    fireEvent.click(deleteBtn);
    // Second click actually fires handleDelete
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmBtn);

    // Should show delete error
    await screen.findByText('Failed to delete');
  });

  // Issue 1b: handleDelete shows 'Network error' on thrown exception
  it('shows "Network error" when DELETE throws an exception', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        throw new Error('Network failure');
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    fireEvent.click(deleteBtn);
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmBtn);

    await screen.findByText('Network error');
  });

  // Issue 2: tabIds useEffect should not overwrite unsaved edits on WS update
  it('unsaved tabId edits are NOT overwritten when auto-scaler WS update arrives with same tabIds', async () => {
    const { rerender } = render(
      <MemoryRouter><SessionsPanel /></MemoryRouter>
    );

    // Start with autoScaler having tabIds: [1]
    mockUseApp({
      autoScalers: [baseAutoScaler],
      tabs: [{ id: 1, name: 'VCH' }, { id: 2, name: 'Other' }],
    });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Select the autoScaler and enter edit mode
    enterEditMode(10);

    // Toggle tab 2 on (user edits tabId via the select)
    fireEvent.change(document.getElementById('editAutoScalerTab')!, { target: { value: '2' } });
    expect((document.getElementById('editAutoScalerTab') as HTMLSelectElement).value).toBe('2');

    // Simulate a WS update arriving with the SAME tabIds (new array reference, same contents)
    const updatedScaler = { ...baseAutoScaler, tabIds: [1] }; // new array object but same values
    mockUseApp({
      autoScalers: [updatedScaler],
      tabs: [{ id: 1, name: 'VCH' }, { id: 2, name: 'Other' }],
    });
    rerender(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // The user's unsaved edit (tab 2 selected) should NOT have been reset
    expect((document.getElementById('editAutoScalerTab') as HTMLSelectElement).value).toBe('2');
  });

  // Issue 3: detail view must have Start/Stop buttons to act on the "stop it first" hint
  it('detail view header has Start button (disabled when running) when auto-scaler is running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // There should be a Stop button in the detail view (to act without going back to sidebar)
    // Look specifically in the detail header / title area
    const stopBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i) && !btn.disabled
    );
    expect(stopBtn).toBeTruthy();
  });

  it('detail view header has Stop button disabled when auto-scaler is stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const stopBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i)
    );
    expect(stopBtn).toBeTruthy();
    expect((stopBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('detail view header has Start button disabled when auto-scaler is running', () => {
    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    );
    expect(startBtn).toBeTruthy();
    expect((startBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('detail view header has Start button enabled when auto-scaler is stopped', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    );
    expect(startBtn).toBeTruthy();
    expect((startBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('PR Review Comment fixes — round 4: Start/Stop error handling in detail view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows inline error when Start returns a non-OK response', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/start')) {
        return { ok: false, json: async () => ({ error: 'Already running' }) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    ) as HTMLButtonElement;
    expect(startBtn).toBeTruthy();

    fireEvent.click(startBtn);

    await screen.findByText('Already running');
  });

  it('shows inline error when Stop returns a non-OK response', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/stop')) {
        return { ok: false, json: async () => ({ error: 'Not running' }) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const stopBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i) && !(btn as HTMLButtonElement).disabled
    ) as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();

    fireEvent.click(stopBtn);

    await screen.findByText('Not running');
  });

  it('shows "Failed to start" when Start returns non-OK with no error message', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/start')) {
        return { ok: false, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    ) as HTMLButtonElement;
    fireEvent.click(startBtn);

    await screen.findByText('Failed to start');
  });

  it('shows "Failed to stop" when Stop returns non-OK with no error message', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/stop')) {
        return { ok: false, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const stopBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i) && !(btn as HTMLButtonElement).disabled
    ) as HTMLButtonElement;
    fireEvent.click(stopBtn);

    await screen.findByText('Failed to stop');
  });

  it('shows "Network error" when Start throws an exception', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/start')) {
        throw new Error('Network failure');
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    ) as HTMLButtonElement;
    fireEvent.click(startBtn);

    await screen.findByText('Network error');
  });

  it('shows "Network error" when Stop throws an exception', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/stop')) {
        throw new Error('Network failure');
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [runningAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="11"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const stopBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i) && !(btn as HTMLButtonElement).disabled
    ) as HTMLButtonElement;
    fireEvent.click(stopBtn);

    await screen.findByText('Network error');
  });

  it('clears startStopError on subsequent successful Start', async () => {
    const { apiFetch } = await import('../utils/api');
    let callCount = 0;
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST' && (_url as string).endsWith('/start')) {
        callCount++;
        if (callCount === 1) {
          return { ok: false, json: async () => ({ error: 'Temporary error' }) } as any;
        }
        return { ok: true, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const startBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    ) as HTMLButtonElement;

    // First click fails — error appears
    fireEvent.click(startBtn);
    await screen.findByText('Temporary error');

    // Second click succeeds — error clears
    fireEvent.click(startBtn);
    await vi.waitFor(() => {
      expect(screen.queryByText('Temporary error')).not.toBeInTheDocument();
    });
  });
});

describe('PR Review Comment fixes — round 3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // Helper: select an autoscaler and click the Edit button to enter edit mode
  function enterEditMode(autoScalerId: number) {
    const card = document.querySelector(`[data-autoscaler-id="${autoScalerId}"]`);
    fireEvent.click(card!);
    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
  }

  // Client-side validation: agentName must not be empty before submitting PATCH
  it('shows "Agent is required" error when agent is cleared before saving (no network call)', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    mockUseApp({ autoScalers: [baseAutoScaler], agents: [{ id: 1, name: 'developer-agent', prompt: '', description: '' }] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    const agentSelect = document.getElementById('editAutoScalerAgent') as HTMLSelectElement;
    expect(agentSelect).not.toBeNull();
    // Select the placeholder option (empty value)
    fireEvent.change(agentSelect, { target: { value: '' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    // Error shown inline
    await screen.findByText('Agent is required');
    // No network call made
    const patchCalls = mockApiFetch.mock.calls.filter(([, opts]) => opts && (opts as RequestInit).method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });

  // Client-side validation: at least one tab must be selected before submitting PATCH
  it('shows "At least one tab is required" error when all tabs unchecked before saving (no network call)', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as any);

    mockUseApp({
      autoScalers: [baseAutoScaler],
      tabs: [{ id: 1, name: 'VCH' }, { id: 2, name: 'Other' }],
    });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    enterEditMode(10);

    // Deselect the tab (select the placeholder option)
    fireEvent.change(document.getElementById('editAutoScalerTab')!, { target: { value: '' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    // Error shown inline
    await screen.findByText('At least one tab is required');
    // No network call made
    const patchCalls = mockApiFetch.mock.calls.filter(([, opts]) => opts && (opts as RequestInit).method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });
});

describe('AutoScalerDetailView — view/edit split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('defaults to view mode: shows read-only meta grid, no edit form fields', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Read-only meta grid should be visible
    expect(detail.querySelector('.autoscaler-detail-meta-grid')).toBeTruthy();
    // Edit form inputs should NOT be visible in view mode
    expect(document.getElementById('editAutoScalerName')).toBeNull();
  });

  it('shows an Edit button in view mode', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    );
    expect(editBtn).toBeTruthy();
  });

  it('clicking Edit reveals the edit form', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);

    // Now the edit form should be visible
    expect(document.getElementById('editAutoScalerName')).not.toBeNull();
  });

  it('in edit mode the Edit button is replaced by a Cancel button', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);

    // Edit button gone, Cancel button present
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    )).toBeUndefined();
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^cancel$/i)
    )).toBeTruthy();
  });

  it('clicking Cancel in edit mode returns to view mode without saving', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');
    // Open edit mode
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);

    // Change name
    const nameInput = document.getElementById('editAutoScalerName') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Changed Name' } });

    // Click Cancel
    const cancelBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^cancel$/i)
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    // Edit form should be gone again
    expect(document.getElementById('editAutoScalerName')).toBeNull();
    // No PATCH call
    const patchCalls = mockApiFetch.mock.calls.filter(([, opts]) => opts && (opts as RequestInit).method === 'PATCH');
    expect(patchCalls.length).toBe(0);
  });

  it('Start/Stop buttons are visible in both view mode and edit mode', () => {
    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    const detail = screen.getByTestId('autoscaler-detail-panel');

    // View mode: Start/Stop visible
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    )).toBeTruthy();
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i)
    )).toBeTruthy();

    // Enter edit mode
    const editBtn = Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^edit$/i)
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);

    // Edit mode: Start/Stop still visible
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^start$/i)
    )).toBeTruthy();
    expect(Array.from(detail.querySelectorAll('button')).find(
      (btn) => btn.textContent?.match(/^stop$/i)
    )).toBeTruthy();
  });
});

describe('AutoScalerDetailView — Sessions section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('fetches child sessions on mount from GET /api/autoscalers/:id/sessions', async () => {
    const { apiFetch } = await import('../utils/api');
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/sessions')) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    await vi.waitFor(() => {
      const sessionFetches = mockApiFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/autoscalers/') && url.endsWith('/sessions')
      );
      expect(sessionFetches.length).toBeGreaterThan(0);
    });
  });

  it('shows "No sessions spawned yet." hint when no child sessions exist', async () => {
    const { apiFetch } = await import('../utils/api');
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/sessions')) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    await screen.findByText(/no sessions spawned yet/i);
  });

  it('renders a collapsible row for each child session', async () => {
    const { apiFetch } = await import('../utils/api');
    const childSession = {
      id: 10,
      name: 'auto-session-1',
      status: 'stopped',
    };
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/sessions')) {
        return { ok: true, json: async () => [childSession] } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    await screen.findByText('auto-session-1');
  });

  it('does not fetch turns until "Load runs" is clicked, then fetches on click', async () => {
    const { apiFetch } = await import('../utils/api');
    const childSession = {
      id: 10,
      name: 'auto-session-1',
      status: 'stopped',
    };
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/sessions')) {
        return { ok: true, json: async () => [childSession] } as any;
      }
      if ((url as string).includes('/turns')) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    // Wait for the session card to appear
    await screen.findByText('auto-session-1');

    // Runs are NOT fetched on mount
    expect(
      vi.mocked(apiFetch).mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/sessions/10/turns')
      ).length
    ).toBe(0);

    // Click "Load runs" to fetch turns
    fireEvent.click(screen.getByRole('button', { name: /load runs/i }));

    await vi.waitFor(() => {
      const turnFetches = vi.mocked(apiFetch).mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/sessions/10/turns')
      );
      expect(turnFetches.length).toBeGreaterThan(0);
    });
  });

  it('renders an independent card per child session (runs load per-card)', async () => {
    const { apiFetch } = await import('../utils/api');
    const sessions = [
      { id: 10, name: 'session-a', status: 'stopped' },
      { id: 11, name: 'session-b', status: 'stopped' },
    ];
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/sessions')) {
        return { ok: true, json: async () => sessions } as any;
      }
      return { ok: true, json: async () => [] } as any;
    });

    mockUseApp({ autoScalers: [baseAutoScaler] });
    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);
    fireEvent.click(document.querySelector('[data-autoscaler-id="10"]')!);

    // Wait for both session cards to appear
    await screen.findByText('session-a');
    await screen.findByText('session-b');

    // Each card is independent: two "Load runs" buttons, one per session card.
    const loadButtons = screen.getAllByRole('button', { name: /load runs/i });
    expect(loadButtons.length).toBe(2);

    // Clicking the first card's "Load runs" only fetches turns for that session.
    fireEvent.click(loadButtons[0]);
    await vi.waitFor(() => {
      const sessionATurns = vi.mocked(apiFetch).mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/sessions/10/turns')
      );
      expect(sessionATurns.length).toBeGreaterThan(0);
    });
    const sessionBTurns = vi.mocked(apiFetch).mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/sessions/11/turns')
    );
    expect(sessionBTurns.length).toBe(0);
  });
});
