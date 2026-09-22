/**
 * Tests for the AutoScalerCreateView create form (task #1977).
 *
 * AutoScalerCreateView renders the "New Auto-Scaler" form in the right-hand
 * detail panel. The tab is read-only (derived from the active tab in context).
 * On submit it validates name/agent/tab, POSTs to /api/autoscalers, refreshes
 * the list, and calls onCreated(newId); Cancel calls onClose().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import { apiFetch } from '../utils/api';

// ---- Mocks ----

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) }),
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

// Import after mocks
import { AutoScalerCreateView } from '../components/AutoScalerPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [{ id: 1, name: 'developer-agent', prompt: '', description: '' }],
    tabs: [{ id: 1, name: 'TecFactory' }, { id: 2, name: 'IDP_IN' }],
    currentTabId: 1,
    fetchAutoScalers: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('AutoScalerCreateView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) } as any);
  });

  it('renders the create form with the current tab shown read-only', () => {
    mockUseApp({ currentTabId: 1 });
    render(<AutoScalerCreateView onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'New Auto-Scaler' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    // Tab is read-only text, not a select — the current tab's name is displayed.
    expect(screen.getByText('TecFactory')).toBeInTheDocument();
  });

  it('shows a validation error and does not POST when the name is empty', () => {
    mockUseApp({ currentTabId: 1 });
    render(<AutoScalerCreateView onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create Auto-Scaler' }));

    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows a validation error and does not POST when no agent is selected', () => {
    mockUseApp({ currentTabId: 1 });
    render(<AutoScalerCreateView onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Scaler' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Auto-Scaler' }));

    expect(screen.getByText('Agent is required')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('POSTs the form, refreshes the list, and calls onCreated on success', async () => {
    const ctx = mockUseApp({ currentTabId: 1 });
    const onCreated = vi.fn();
    render(<AutoScalerCreateView onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Scaler' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'developer-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Auto-Scaler' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(99));

    expect(apiFetch).toHaveBeenCalledWith('/api/autoscalers', expect.objectContaining({
      method: 'POST',
    }));
    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(JSON.parse((options as RequestInit).body as string)).toMatchObject({
      name: 'My Scaler',
      agentName: 'developer-agent',
      tabIds: [1],
    });
    expect(ctx.fetchAutoScalers).toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', () => {
    mockUseApp({ currentTabId: 1 });
    const onClose = vi.fn();
    render(<AutoScalerCreateView onClose={onClose} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('disables the create button when no tab is active', () => {
    mockUseApp({ currentTabId: null });
    render(<AutoScalerCreateView onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create Auto-Scaler' })).toBeDisabled();
  });
});
