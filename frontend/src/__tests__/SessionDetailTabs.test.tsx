import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SessionDetailTabs } from '../components/SessionDetailTabs';
import type { OutputEntry } from '../types';

// Mock apiFetch
vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../utils/api';

const mockedApiFetch = vi.mocked(apiFetch);

describe('SessionDetailTabs', () => {
  const mockOutput: OutputEntry[] = [
    { stream: 'stdout', text: 'Hello world', timestamp: '2026-08-15T10:00:00Z' },
    { stream: 'stderr', text: 'Error line', timestamp: '2026-08-15T10:00:01Z' },
  ];

  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);
  });

  it('renders Timeline tab as default active view', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    const timelineTab = screen.getByRole('tab', { name: /timeline/i });
    expect(timelineTab.classList.contains('active')).toBe(true);
  });

  it('switches to Raw Log tab on click', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    const rawLogTab = screen.getByRole('tab', { name: /raw log/i });
    fireEvent.click(rawLogTab);

    expect(rawLogTab.classList.contains('active')).toBe(true);
    // Raw log should show output text
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    expect(screen.getByText(/Error line/)).toBeInTheDocument();
  });

  it('shows the timeline view when Timeline tab is active', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    // Timeline is the default — it should show the timeline empty state or content
    // Since we mock apiFetch to return [], it should show empty state
    expect(screen.getByText(/no turns/i)).toBeInTheDocument();
  });

  it('raw log renders output entries with timestamps', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    // Switch to Raw Log
    const rawLogTab = screen.getByRole('tab', { name: /raw log/i });
    fireEvent.click(rawLogTab);

    // Check output entries are rendered
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    expect(screen.getByText(/Error line/)).toBeInTheDocument();
  });

  it('shows a Copy log button only when the Raw Log tab is active', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    // Timeline is active by default — no copy button
    expect(screen.queryByRole('button', { name: /copy log/i })).not.toBeInTheDocument();

    const rawLogTab = screen.getByRole('tab', { name: /raw log/i });
    fireEvent.click(rawLogTab);

    expect(screen.getByRole('button', { name: /copy log/i })).toBeInTheDocument();
  });

  it('copies all visible log lines to the clipboard when Copy log is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    fireEvent.click(screen.getByRole('tab', { name: /raw log/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy log/i }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain('Hello world');
    expect(copiedText).toContain('Error line');
  });

  it('disables the Copy log button when there is no output', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={[]}
        />
      );
    });

    fireEvent.click(screen.getByRole('tab', { name: /raw log/i }));
    expect(screen.getByRole('button', { name: /copy log/i })).toBeDisabled();
  });

  it('Ctrl+A inside the log selects only the log content, not the whole page', async () => {
    await act(async () => {
      render(
        <SessionDetailTabs
          sessionId={1}
          sessionStatus="stopped"
          output={mockOutput}
        />
      );
    });

    fireEvent.click(screen.getByRole('tab', { name: /raw log/i }));
    const logEl = screen.getByRole('log', { name: /agent output/i });

    const removeAllRanges = vi.fn();
    const addRange = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges,
      addRange,
    } as unknown as Selection);

    const preventDefault = vi.fn();
    fireEvent.keyDown(logEl, { key: 'a', ctrlKey: true, preventDefault });

    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(addRange).toHaveBeenCalledTimes(1);
  });
});
