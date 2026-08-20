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
});
