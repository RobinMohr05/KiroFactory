/**
 * Tests for AutoScalerSessionCard (task #1969).
 *
 * Each pooled session in the AutoScaler detail view is rendered as an AntD Card
 * that lazily loads its runs (turns) and its logs (output). Runs are never
 * auto-loaded — only when the "Load runs" button is clicked. Logs are fetched
 * lazily and independently on Copy/Download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Session, TurnRecord, OutputEntry } from '../types';

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
  // Reuse the real relative-time helper shape in tests
  formatErrorTime: (iso: string) => `rel(${iso})`,
}));

import { apiFetch } from '../utils/api';
import { AutoScalerSessionCard } from '../components/AutoScalerSessionCard';

const mockedApiFetch = vi.mocked(apiFetch);

const session: Session = {
  id: 42,
  name: 'pool-worker-1',
  status: 'running',
};

const turns: TurnRecord[] = [
  {
    number: 1,
    startedAt: '2026-09-22T10:00:00Z',
    endedAt: '2026-09-22T10:05:00Z',
    credits: 100,
    costEur: 1.23,
    verdict: 'resolved',
    taskId: 7,
    taskTitle: 'Fix the thing',
    toolCallCount: 3,
    hasChanges: true,
    prUrl: null,
    branchName: null,
    durationMs: 65000,
    sessionId: 42,
  },
];

const output: OutputEntry[] = [
  { stream: 'stdout', text: 'line one', timestamp: '2026-09-22T10:00:00Z' },
  { stream: 'stderr', text: 'line two', timestamp: '2026-09-22T10:00:01Z' },
];

function mockRoutes(opts: { turns?: TurnRecord[]; output?: OutputEntry[]; failTurns?: boolean; failOutput?: boolean } = {}) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    if (url.includes('/turns')) {
      if (opts.failTurns) return { ok: false, status: 500, json: async () => ({}) } as any;
      return { ok: true, json: async () => opts.turns ?? [] } as any;
    }
    if (url.includes('/output')) {
      if (opts.failOutput) return { ok: false, status: 500, json: async () => ({}) } as any;
      return { ok: true, json: async () => opts.output ?? [] } as any;
    }
    return { ok: true, json: async () => [] } as any;
  });
}

describe('AutoScalerSessionCard', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders session name and status badge without fetching runs', () => {
    mockRoutes();
    render(<AutoScalerSessionCard session={session} />);
    expect(screen.getByText('pool-worker-1')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    // No runs fetched on mount
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('loads runs only on click, renders run rows, and relabels button to Refresh', async () => {
    mockRoutes({ turns });
    render(<AutoScalerSessionCard session={session} />);

    const loadBtn = screen.getByRole('button', { name: /load runs/i });
    fireEvent.click(loadBtn);

    await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/sessions/42/turns');
    // relabels to Refresh
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    // verdict shown, credits/cost NOT shown
    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.queryByText(/1.23/)).not.toBeInTheDocument();
  });

  it('shows "No runs yet" when there are zero runs', async () => {
    mockRoutes({ turns: [] });
    render(<AutoScalerSessionCard session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /load runs/i }));
    await waitFor(() => expect(screen.getByText(/no runs yet/i)).toBeInTheDocument());
  });

  it('shows an inline error when the runs fetch fails', async () => {
    mockRoutes({ failTurns: true });
    render(<AutoScalerSessionCard session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /load runs/i }));
    await waitFor(() => expect(screen.getByText(/failed to load runs/i)).toBeInTheDocument());
  });

  it('copies logs to the clipboard on Copy logs click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockRoutes({ output });
    render(<AutoScalerSessionCard session={session} />);

    fireEvent.click(screen.getByRole('button', { name: /copy logs/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/sessions/42/output');
    expect(writeText.mock.calls[0][0]).toContain('line one');
    expect(writeText.mock.calls[0][0]).toContain('line two');
  });

  it('shows "No logs available" when the output is empty on Copy', async () => {
    mockRoutes({ output: [] });
    render(<AutoScalerSessionCard session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /copy logs/i }));
    await waitFor(() => expect(screen.getByText(/no logs available/i)).toBeInTheDocument());
  });

  it('downloads logs as a .log blob on Download logs click', async () => {
    mockRoutes({ output });
    const createObjectURL = vi.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<AutoScalerSessionCard session={session} />);
    fireEvent.click(screen.getByRole('button', { name: /download logs/i }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/sessions/42/output');
    expect(clickSpy).toHaveBeenCalled();
  });
});
