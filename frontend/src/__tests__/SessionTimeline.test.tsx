import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SessionTimeline } from '../components/SessionTimeline';
import type { TimelineTurn } from '../types';

// Mock apiFetch
vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../utils/api';

const mockedApiFetch = vi.mocked(apiFetch);

describe('SessionTimeline', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when session has no turns', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="stopped" />);
    });

    expect(screen.getByText(/no turns/i)).toBeInTheDocument();
  });

  it('renders turn headers with all metadata', async () => {
    const turns = [
      {
        number: 1,
        startedAt: '2026-08-15T10:00:00Z',
        endedAt: '2026-08-15T10:05:00Z',
        credits: 2.5,
        costEur: 0.10,
        verdict: 'resolved',
        taskId: 42,
        taskTitle: 'Fix the bug',
        toolCallCount: 3,
        hasChanges: true,
        prUrl: 'https://github.com/test/repo/pull/1',
        branchName: 'fix/bug',
        durationMs: 300000,
        sessionId: 1,
      },
    ];

    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => turns,
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="stopped" />);
    });

    // Turn number
    expect(screen.getByText(/Turn 1/)).toBeInTheDocument();
    // Duration
    expect(screen.getByText(/5m 0s/)).toBeInTheDocument();
    // Credits with EUR
    expect(screen.getByText(/2\.50/)).toBeInTheDocument();
    expect(screen.getByText(/€0\.10/)).toBeInTheDocument();
    // Verdict badge
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
    // Task title
    expect(screen.getByText(/Fix the bug/)).toBeInTheDocument();
    // PR link
    const prLink = screen.getByRole('link', { name: /PR/i });
    expect(prLink).toHaveAttribute('href', 'https://github.com/test/repo/pull/1');
  });

  it('renders verdict badges with correct styling class', async () => {
    const turns = [
      {
        number: 1,
        startedAt: '2026-08-15T10:00:00Z',
        endedAt: '2026-08-15T10:05:00Z',
        credits: 1,
        costEur: 0.04,
        verdict: 'resolved',
        taskId: null,
        taskTitle: null,
        toolCallCount: 0,
        hasChanges: false,
        prUrl: null,
        branchName: null,
        durationMs: 300000,
        sessionId: 1,
      },
      {
        number: 2,
        startedAt: '2026-08-15T10:05:00Z',
        endedAt: '2026-08-15T10:10:00Z',
        credits: 1,
        costEur: 0.04,
        verdict: 'no_action_needed',
        taskId: null,
        taskTitle: null,
        toolCallCount: 0,
        hasChanges: false,
        prUrl: null,
        branchName: null,
        durationMs: 300000,
        sessionId: 1,
      },
      {
        number: 3,
        startedAt: '2026-08-15T10:10:00Z',
        endedAt: '2026-08-15T10:15:00Z',
        credits: 1,
        costEur: 0.04,
        verdict: 'changes_requested',
        taskId: null,
        taskTitle: null,
        toolCallCount: 0,
        hasChanges: false,
        prUrl: null,
        branchName: null,
        durationMs: 300000,
        sessionId: 1,
      },
    ];

    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => turns,
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="stopped" />);
    });

    const resolvedBadge = screen.getByText('resolved');
    expect(resolvedBadge.className).toContain('verdict-resolved');

    const noActionBadge = screen.getByText('no_action_needed');
    expect(noActionBadge.className).toContain('verdict-no_action_needed');

    const changesRequestedBadge = screen.getByText('changes_requested');
    expect(changesRequestedBadge.className).toContain('verdict-changes_requested');
  });

  it('renders tool call cards that expand/collapse on click', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    const { container } = await act(async () => {
      return render(<SessionTimeline sessionId={1} sessionStatus="running" />);
    });

    // Simulate a turn-start event
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-start', {
        detail: { sessionId: 1, turnNumber: 1, startedAt: '2026-08-15T10:00:00Z' },
      }));
    });

    // Simulate a tool call event
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-tool-call', {
        detail: {
          sessionId: 1,
          turnNumber: 1,
          toolCallId: 'tc1',
          label: 'read_file',
          icon: '📄',
          status: 'running',
        },
      }));
    });

    // Tool call should be visible
    expect(screen.getByText('read_file')).toBeInTheDocument();

    // Simulate tool call completion with output
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-tool-call-update', {
        detail: {
          sessionId: 1,
          turnNumber: 1,
          toolCallId: 'tc1',
          status: 'completed',
          output: 'File contents here...',
          durationMs: 150,
        },
      }));
    });

    // Output should be collapsed by default (not visible)
    const outputText = container.querySelector('.tool-call-output');
    expect(outputText).not.toBeNull();
    expect(outputText!.classList.contains('expanded')).toBe(false);

    // Click to expand
    const toolCallCard = screen.getByText('read_file').closest('.tool-call-card');
    expect(toolCallCard).not.toBeNull();
    fireEvent.click(toolCallCard!.querySelector('.tool-call-header')!);

    // Output should now be expanded
    await waitFor(() => {
      const expandedOutput = container.querySelector('.tool-call-output.expanded');
      expect(expandedOutput).not.toBeNull();
    });
  });

  it('shows failed tool calls with distinct red styling', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="running" />);
    });

    // Simulate a turn-start
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-start', {
        detail: { sessionId: 1, turnNumber: 1, startedAt: '2026-08-15T10:00:00Z' },
      }));
    });

    // Simulate a tool call that will fail
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-tool-call', {
        detail: {
          sessionId: 1,
          turnNumber: 1,
          toolCallId: 'tc-fail',
          label: 'shell',
          icon: '💻',
          status: 'running',
        },
      }));
    });

    // Simulate failure
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-tool-call-update', {
        detail: {
          sessionId: 1,
          turnNumber: 1,
          toolCallId: 'tc-fail',
          status: 'failed',
          output: 'Error: command not found',
        },
      }));
    });

    const toolCallCard = screen.getByText('shell').closest('.tool-call-card');
    expect(toolCallCard).not.toBeNull();
    expect(toolCallCard!.classList.contains('tool-call-failed')).toBe(true);
  });

  it('shows a live running state for active turns with elapsed time', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="running" />);
    });

    // Simulate turn start
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-start', {
        detail: { sessionId: 1, turnNumber: 1, startedAt: new Date().toISOString() },
      }));
    });

    // Should show a running indicator
    expect(screen.getByText(/Turn 1/)).toBeInTheDocument();
    const turnHeader = screen.getByText(/Turn 1/).closest('.turn-header');
    expect(turnHeader).not.toBeNull();
    expect(turnHeader!.classList.contains('turn-active')).toBe(true);
  });

  it('finalizes the turn header when session-turn-end is received', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="running" />);
    });

    // Start a turn
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-start', {
        detail: { sessionId: 1, turnNumber: 1, startedAt: '2026-08-15T10:00:00Z', taskTitle: 'Test task' },
      }));
    });

    // End the turn
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-end', {
        detail: {
          sessionId: 1,
          turnNumber: 1,
          summary: {
            credits: 3.5,
            costEur: 0.14,
            verdict: 'resolved',
            durationMs: 120000,
            toolCallCount: 5,
            hasChanges: true,
            prUrl: 'https://github.com/test/repo/pull/2',
          },
        },
      }));
    });

    // Turn should no longer be active
    const turnHeader = screen.getByText(/Turn 1/).closest('.turn-header');
    expect(turnHeader!.classList.contains('turn-active')).toBe(false);

    // Summary data should be displayed
    expect(screen.getByText(/3\.50/)).toBeInTheDocument();
    expect(screen.getByText(/€0\.14/)).toBeInTheDocument();
    expect(screen.getByText(/resolved/)).toBeInTheDocument();
    expect(screen.getByText(/2m 0s/)).toBeInTheDocument();
  });

  it('ignores events for different session IDs', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      render(<SessionTimeline sessionId={1} sessionStatus="running" />);
    });

    // Simulate turn for a DIFFERENT session
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-turn-start', {
        detail: { sessionId: 999, turnNumber: 1, startedAt: '2026-08-15T10:00:00Z' },
      }));
    });

    // Should still show empty state
    expect(screen.getByText(/no turns/i)).toBeInTheDocument();
  });

  it('refetches turns when sessionId changes', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    const { rerender } = await act(async () => {
      return render(<SessionTimeline sessionId={1} sessionStatus="stopped" />);
    });

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/sessions/1/turns');

    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    await act(async () => {
      rerender(<SessionTimeline sessionId={2} sessionStatus="stopped" />);
    });

    expect(mockedApiFetch).toHaveBeenCalledWith('/api/sessions/2/turns');
  });
});
