import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsagePanel } from '../components/UsagePanel';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockSetActiveView = vi.fn();
const mockSetActiveSessionId = vi.fn();

// Two months of cached data, ordered oldest -> newest (as the endpoint returns).
// July 2026 (older) and August 2026 (current/newest).
const julyMonth = {
  year: 2026,
  month: 7,
  monthLabel: 'July 2026',
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-31T23:59:59.999Z',
  totalCredits: 8.0,
  totalCostEur: 0.32,
  totalTurns: 2,
  dailyBreakdown: [
    { date: '2026-07-10', credits: 8.0, costEur: 0.32 },
  ],
  sessionBreakdown: [
    {
      sessionId: 3,
      sessionName: 'July Session',
      agent: 'developer-agent',
      tabId: 1,
      tabName: 'Tab A',
      credits: 8.0,
      costEur: 0.32,
      turns: 2,
      firstTurn: '2026-07-10T10:00:00.000Z',
      lastTurn: '2026-07-10T15:00:00.000Z',
    },
  ],
};

const augustMonth = {
  year: 2026,
  month: 8,
  monthLabel: 'August 2026',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-31T23:59:59.999Z',
  totalCredits: 25.5,
  totalCostEur: 1.02,
  totalTurns: 8,
  dailyBreakdown: [
    { date: '2026-08-01', credits: 10.0, costEur: 0.40 },
    { date: '2026-08-05', credits: 15.5, costEur: 0.62 },
  ],
  sessionBreakdown: [
    {
      sessionId: 1,
      sessionName: 'Dev Session',
      agent: 'developer-agent',
      tabId: 1,
      tabName: 'Tab A',
      credits: 15.5,
      costEur: 0.62,
      turns: 5,
      firstTurn: '2026-08-01T10:00:00.000Z',
      lastTurn: '2026-08-05T15:00:00.000Z',
    },
    {
      sessionId: 2,
      sessionName: 'Review Session',
      agent: 'code-reviewer-agent',
      tabId: 2,
      tabName: 'Tab B',
      credits: 10.0,
      costEur: 0.40,
      turns: 3,
      firstTurn: '2026-08-01T08:00:00.000Z',
      lastTurn: '2026-08-01T12:00:00.000Z',
    },
  ],
};

const mockMonthlyResponse = { months: [julyMonth, augustMonth] };

function mockMonthly(response: unknown, ok = true) {
  vi.mocked(api.apiFetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => response,
  } as any);
}

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AppContext.useApp).mockReturnValue({
      tabs: [
        { id: 1, name: 'Tab A' },
        { id: 2, name: 'Tab B' },
      ],
      setActiveView: mockSetActiveView,
      setActiveSessionId: mockSetActiveSessionId,
    } as any);
  });

  it('shows loading state initially', () => {
    vi.mocked(api.apiFetch).mockReturnValue(new Promise(() => {})); // Never resolves
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    expect(screen.getByText('Loading usage data…')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    mockMonthly({}, false);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
    });
  });

  it('opens on the current (newest) month', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });
    expect(screen.getByText('25.50 credits')).toBeInTheDocument();
    expect(screen.getByText('EUR 1.02')).toBeInTheDocument();
  });

  it('fetches the monthly endpoint exactly once on mount', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
    expect(api.apiFetch).toHaveBeenCalledWith('/api/usage/monthly');
  });

  it('renders session data for the selected month', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });
    expect(screen.getByText('Review Session')).toBeInTheDocument();
    expect(screen.getByText('developer-agent')).toBeInTheDocument();
    expect(screen.getByText('code-reviewer-agent')).toBeInTheDocument();
  });

  it('navigates between months without any network request', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });

    expect(api.apiFetch).toHaveBeenCalledTimes(1);

    // Go back to July.
    fireEvent.click(screen.getByLabelText('Previous month'));
    await waitFor(() => {
      expect(screen.getByText('July 2026')).toBeInTheDocument();
    });
    expect(screen.getByText('8.00 credits')).toBeInTheDocument();
    expect(screen.getByText('July Session')).toBeInTheDocument();

    // Go forward to August again.
    fireEvent.click(screen.getByLabelText('Next month'));
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });

    // No additional fetch was triggered by navigation.
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('disables the forward arrow at the current month and the back arrow at the oldest', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });

    // At the newest month: forward disabled, back enabled.
    expect(screen.getByLabelText('Next month')).toBeDisabled();
    expect(screen.getByLabelText('Previous month')).not.toBeDisabled();

    // Move to the oldest month.
    fireEvent.click(screen.getByLabelText('Previous month'));
    await waitFor(() => {
      expect(screen.getByText('July 2026')).toBeInTheDocument();
    });

    // At the oldest month: back disabled, forward enabled.
    expect(screen.getByLabelText('Previous month')).toBeDisabled();
    expect(screen.getByLabelText('Next month')).not.toBeDisabled();
  });

  it('renders the tab filter dropdown', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by tab')).toBeInTheDocument();
    });
    expect(screen.getByText('All Tabs')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tab A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tab B' })).toBeInTheDocument();
  });

  it('filters totals and sessions from cache when tab changes, without refetching', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('25.50 credits')).toBeInTheDocument();
    });

    expect(api.apiFetch).toHaveBeenCalledTimes(1);

    // Select Tab B — only the Review Session (tabId 2, 10.0 credits) remains.
    fireEvent.change(screen.getByLabelText('Filter by tab'), { target: { value: '2' } });

    await waitFor(() => {
      expect(screen.getByText('10.00 credits')).toBeInTheDocument();
    });
    expect(screen.getByText('Review Session')).toBeInTheDocument();
    expect(screen.queryByText('Dev Session')).not.toBeInTheDocument();

    // No network request fired for the tab change.
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('persists the tab filter across month navigation', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('August 2026')).toBeInTheDocument();
    });

    // Filter to Tab A.
    fireEvent.change(screen.getByLabelText('Filter by tab'), { target: { value: '1' } });
    await waitFor(() => {
      // August Tab A = Dev Session (15.5).
      expect(screen.getByText('15.50 credits')).toBeInTheDocument();
    });

    // Navigate to July — filter should still be Tab A.
    fireEvent.click(screen.getByLabelText('Previous month'));
    await waitFor(() => {
      expect(screen.getByText('July 2026')).toBeInTheDocument();
    });
    expect((screen.getByLabelText('Filter by tab') as HTMLSelectElement).value).toBe('1');
    // July Tab A = July Session (8.0).
    expect(screen.getByText('8.00 credits')).toBeInTheDocument();
    expect(screen.getByText('July Session')).toBeInTheDocument();
  });

  it('sorts sessions when header is clicked', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    // Click "Turns" header (new key -> desc), then again to toggle to asc.
    fireEvent.click(screen.getByText(/^Turns/));
    fireEvent.click(screen.getByText(/^Turns/));

    const updatedRows = screen.getAllByRole('button').filter(
      el => el.textContent?.includes('Session')
    );
    expect(updatedRows[0]).toHaveTextContent('Review Session');
    expect(updatedRows[1]).toHaveTextContent('Dev Session');
  });

  it('navigates to session detail on row click', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dev Session'));
    expect(mockSetActiveSessionId).toHaveBeenCalledWith(1);
    expect(mockNavigate).toHaveBeenCalledWith('/sessions/1');
  });

  it('shows empty state when the selected month has no sessions', async () => {
    mockMonthly({
      months: [
        {
          year: 2026,
          month: 8,
          monthLabel: 'August 2026',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-31T23:59:59.999Z',
          totalCredits: 0,
          totalCostEur: 0,
          totalTurns: 0,
          dailyBreakdown: [],
          sessionBreakdown: [],
        },
      ],
    });
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('No sessions consumed credits this period.')).toBeInTheDocument();
    });
    expect(screen.getByText('No usage data for this period.')).toBeInTheDocument();
  });

  it('maps daily breakdown dates by string parsing, not timezone-sensitive Date object', async () => {
    // Regression: new Date('2026-08-01').getDate() can return 31 in negative UTC offsets.
    mockMonthly({
      months: [
        {
          year: 2026,
          month: 8,
          monthLabel: 'August 2026',
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-31T23:59:59.999Z',
          totalCredits: 5.0,
          totalCostEur: 0.20,
          totalTurns: 1,
          dailyBreakdown: [
            { date: '2026-08-01', credits: 5.0, costEur: 0.20 },
          ],
          sessionBreakdown: [],
        },
      ],
    });

    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('5.00 credits')).toBeInTheDocument();
    });

    const bar = screen.getByTitle(/Day 1:/);
    expect(bar).toBeInTheDocument();
    expect(bar.getAttribute('title')).toContain('5.00 credits');
  });

  it('renders a Tab column in the session breakdown table', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    expect(screen.getByText('Tab')).toBeInTheDocument();
    // Both August sessions belong to Tab A / Tab B respectively.
    expect(screen.getAllByText('Tab A').length).toBeGreaterThan(0);
  });

  it('makes sortable table headers keyboard-accessible', async () => {
    mockMonthly(mockMonthlyResponse);
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    const creditsHeader = screen.getByText(/^Credits/);
    expect(creditsHeader.closest('th')).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(creditsHeader.closest('th')!, { key: 'Enter' });
    const rows = screen.getAllByRole('button').filter(
      el => el.textContent?.includes('Session')
    );
    expect(rows[0]).toHaveTextContent('Review Session');
    expect(rows[1]).toHaveTextContent('Dev Session');
  });
});
