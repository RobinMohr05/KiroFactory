import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UsagePanel } from '../components/UsagePanel';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

const mockSetActiveView = vi.fn();
const mockSetActiveSessionId = vi.fn();

const mockUsageData = {
  totalCredits: 25.5,
  totalCostEur: 1.02,
  dailyBreakdown: [
    { date: '2026-08-01', credits: 10.0, costEur: 0.40 },
    { date: '2026-08-05', credits: 15.5, costEur: 0.62 },
  ],
  sessionBreakdown: [
    {
      sessionId: 1,
      sessionName: 'Dev Session',
      agent: 'developer-agent',
      tabName: null,
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
      tabName: null,
      credits: 10.0,
      costEur: 0.40,
      turns: 3,
      firstTurn: '2026-08-01T08:00:00.000Z',
      lastTurn: '2026-08-01T12:00:00.000Z',
    },
  ],
};

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
    render(<UsagePanel />);
    expect(screen.getByText('Loading usage data…')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as any);
    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
    });
  });

  it('renders usage data correctly', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('25.50 credits')).toBeInTheDocument();
    });
    expect(screen.getByText('EUR 1.02')).toBeInTheDocument();
    expect(screen.getByText('Dev Session')).toBeInTheDocument();
    expect(screen.getByText('Review Session')).toBeInTheDocument();
    expect(screen.getByText('developer-agent')).toBeInTheDocument();
    expect(screen.getByText('code-reviewer-agent')).toBeInTheDocument();
  });

  it('renders the tab filter dropdown', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by tab')).toBeInTheDocument();
    });
    expect(screen.getByText('All Tabs')).toBeInTheDocument();
    expect(screen.getByText('Tab A')).toBeInTheDocument();
    expect(screen.getByText('Tab B')).toBeInTheDocument();
  });

  it('refetches when tab filter changes', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('25.50 credits')).toBeInTheDocument();
    });

    // Change tab filter
    fireEvent.change(screen.getByLabelText('Filter by tab'), { target: { value: '2' } });
    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('tabId=2')
      );
    });
  });

  it('sorts sessions when header is clicked', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    // Default sort is by credits desc — Dev Session (15.5) comes before Review Session (10.0)
    const sessionCells = screen.getAllByRole('button');
    // The session rows are interactive (role=button)
    const devRow = sessionCells.find(el => el.textContent?.includes('Dev Session'));
    const reviewRow = sessionCells.find(el => el.textContent?.includes('Review Session'));
    expect(devRow).toBeDefined();
    expect(reviewRow).toBeDefined();

    // Click "Turns" header to sort — it will be desc on first click since it's a new key
    fireEvent.click(screen.getByText(/^Turns/));

    // Click again to toggle to ascending (3 turns before 5)
    fireEvent.click(screen.getByText(/^Turns/));

    // After ascending sort, Review Session (3 turns) should appear before Dev Session (5 turns)
    const updatedRows = screen.getAllByRole('button').filter(
      el => el.textContent?.includes('Session')
    );
    expect(updatedRows[0]).toHaveTextContent('Review Session');
    expect(updatedRows[1]).toHaveTextContent('Dev Session');
  });

  it('navigates to session detail on row click', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dev Session'));
    expect(mockSetActiveSessionId).toHaveBeenCalledWith(1);
    expect(mockSetActiveView).toHaveBeenCalledWith('sessions');
  });

  it('shows empty state when no sessions have credits', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCredits: 0,
        totalCostEur: 0,
        dailyBreakdown: [],
        sessionBreakdown: [],
      }),
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('No sessions consumed credits this period.')).toBeInTheDocument();
    });
    expect(screen.getByText('No usage data for this period.')).toBeInTheDocument();
  });

  it('maps daily breakdown dates by string parsing, not timezone-sensitive Date object', async () => {
    // Regression: new Date('2026-08-01').getDate() can return 31 in negative UTC offsets.
    // The fix must parse the day directly from the 'YYYY-MM-DD' string.
    const dataWithDay1 = {
      totalCredits: 5.0,
      totalCostEur: 0.20,
      dailyBreakdown: [
        { date: '2026-08-01', credits: 5.0, costEur: 0.20 },
      ],
      sessionBreakdown: [],
    };

    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => dataWithDay1,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('5.00 credits')).toBeInTheDocument();
    });

    // Day 1 should have the bar with title containing "Day 1"
    const bar = screen.getByTitle(/Day 1:/);
    expect(bar).toBeInTheDocument();
    expect(bar.getAttribute('title')).toContain('5.00 credits');
  });

  it('renders a Tab column in the session breakdown table', async () => {
    const dataWithTabs = {
      totalCredits: 25.5,
      totalCostEur: 1.02,
      dailyBreakdown: [
        { date: '2026-08-01', credits: 10.0, costEur: 0.40 },
      ],
      sessionBreakdown: [
        {
          sessionId: 1,
          sessionName: 'Dev Session',
          agent: 'developer-agent',
          tabName: 'VCH',
          credits: 15.5,
          costEur: 0.62,
          turns: 5,
          firstTurn: '2026-08-01T10:00:00.000Z',
          lastTurn: '2026-08-05T15:00:00.000Z',
        },
      ],
    };

    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => dataWithTabs,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    // There should be a "Tab" column header
    expect(screen.getByText('Tab')).toBeInTheDocument();
    // And the tab name in the row
    expect(screen.getByText('VCH')).toBeInTheDocument();
  });

  it('makes sortable table headers keyboard-accessible', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockUsageData,
    } as any);

    render(<UsagePanel />);
    await waitFor(() => {
      expect(screen.getByText('Dev Session')).toBeInTheDocument();
    });

    // Each sortable th should be keyboard accessible
    const creditsHeader = screen.getByText(/^Credits/);
    expect(creditsHeader.closest('th')).toHaveAttribute('tabindex', '0');

    // Should respond to Enter key
    fireEvent.keyDown(creditsHeader.closest('th')!, { key: 'Enter' });
    // After pressing Enter on credits (already sorted desc), it toggles to asc
    // Review Session (10.0) should now appear before Dev Session (15.5)
    const rows = screen.getAllByRole('button').filter(
      el => el.textContent?.includes('Session')
    );
    expect(rows[0]).toHaveTextContent('Review Session');
    expect(rows[1]).toHaveTextContent('Dev Session');
  });
});
