import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
  formatErrorTime: (t: string) => t,
}));

import { ErrorsPanel } from '../components/ErrorsPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    errors: [],
    setErrors: vi.fn(),
    fetchErrors: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('ErrorsPanel - agent error diagnostic detail', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows turn stats and a collapsible diagnostic detail section when present', () => {
    mockUseApp({
      errors: [
        {
          id: 'e1',
          message: 'Worker disconnected',
          context: 'Error while executing task "Fix bug" (ID: 42, type: bug, priority: P2)',
          agent: 'developer-agent',
          sessionName: 'Dev Loop',
          taskId: 42,
          taskTitle: 'Fix bug',
          timestamp: '2026-08-28T18:24:19.000Z',
          taskCreated: false,
          turnNumber: 1,
          toolCallCount: 3,
          turnDurationMs: 14000,
          stack: 'Error: Worker disconnected\n    at streamPromptAca (session-manager.ts:3300)',
          recentOutput: [
            { timestamp: '2026-08-28T18:24:06.000Z', stream: 'system', text: 'kiro-cli ACP initialized — creating session...' },
            { timestamp: '2026-08-28T18:24:18.000Z', stream: 'stderr', text: 'kiro-cli exited (code: null, signal: SIGTERM)' },
          ],
        },
      ],
    });

    render(<ErrorsPanel />);

    expect(screen.getByText('🔄 Turn 1')).toBeInTheDocument();
    expect(screen.getByText('🔧 3 tool calls')).toBeInTheDocument();
    expect(screen.getByText('⏱ 14s into turn')).toBeInTheDocument();

    // Detail is collapsed by default (native <details>) but its content is
    // present in the DOM either way — assert it's there and findable.
    expect(screen.getByText(/Show diagnostic detail/)).toBeInTheDocument();
    expect(screen.getByText(/kiro-cli exited \(code: null, signal: SIGTERM\)/)).toBeInTheDocument();
    expect(screen.getByText(/at streamPromptAca/)).toBeInTheDocument();
  });

  it('does not show the diagnostic detail section when no enrichment data is present', () => {
    mockUseApp({
      errors: [
        {
          id: 'e2',
          message: 'Task "X" failed 3 consecutive times — blocked for this session',
          context: 'Task ID: 7. Manual investigation is required.',
          agent: 'developer-agent',
          sessionName: 'Dev Loop',
          timestamp: '2026-08-28T18:24:19.000Z',
          taskCreated: false,
        },
      ],
    });

    render(<ErrorsPanel />);
    expect(screen.queryByText(/Show diagnostic detail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/🔄 Turn/)).not.toBeInTheDocument();
  });

  it('copies the full error detail (message, context, turn stats, output, stack) to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    mockUseApp({
      errors: [
        {
          id: 'e3',
          message: 'Worker disconnected',
          context: 'Error while executing task "Fix bug" (ID: 42, type: bug, priority: P2)',
          agent: 'developer-agent',
          sessionName: 'Dev Loop',
          taskId: 42,
          taskTitle: 'Fix bug',
          timestamp: '2026-08-28T18:24:19.000Z',
          taskCreated: false,
          turnNumber: 1,
          toolCallCount: 3,
          turnDurationMs: 14000,
          stack: 'Error: Worker disconnected\n    at streamPromptAca (session-manager.ts:3300)',
          recentOutput: [
            { timestamp: '2026-08-28T18:24:18.000Z', stream: 'stderr', text: 'kiro-cli exited (code: null, signal: SIGTERM)' },
          ],
        },
      ],
    });

    render(<ErrorsPanel />);
    fireEvent.click(screen.getByText('📋 Copy full detail'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('Worker disconnected');
    expect(copied).toContain('Fix bug');
    expect(copied).toContain('Turn: 1');
    expect(copied).toContain('SIGTERM');
    expect(copied).toContain('at streamPromptAca');
  });
});

describe('ErrorsPanel - sub-tab switcher', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/errors/wsl-diagnostics') {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to the Agent Errors sub-tab', () => {
    mockUseApp({ errors: [] });
    render(<ErrorsPanel />);
    expect(screen.getByRole('heading', { name: 'Agent Errors' })).toBeInTheDocument();
    expect(screen.getByText(/No agent errors recorded/)).toBeInTheDocument();
  });

  it('switches to the WSL/Docker Logs sub-tab and fetches the diagnostics buffer', async () => {
    mockUseApp({ errors: [] });
    render(<ErrorsPanel />);

    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    expect(screen.getByRole('heading', { name: 'WSL/Docker Logs' })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/errors/wsl-diagnostics');
    });
  });

  it('does not show the Clear All button while on the WSL/Docker Logs sub-tab', () => {
    mockUseApp({ errors: [] });
    render(<ErrorsPanel />);

    expect(screen.getByText('Clear All')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));
    expect(screen.queryByText('Clear All')).not.toBeInTheDocument();
  });

  it('renders fetched diagnostic lines with their source label', async () => {
    mockUseApp({ errors: [] });
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/errors/wsl-diagnostics') {
        return {
          ok: true,
          json: async () => [
            { id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'docker-events', text: 'container kirofactory-worker-1 killed (signal: 15)', containerName: 'kirofactory-worker-1' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<ErrorsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    await waitFor(() => {
      expect(screen.getByText(/container kirofactory-worker-1 killed \(signal: 15\)/)).toBeInTheDocument();
    });
    expect(screen.getByText('docker events')).toBeInTheDocument();
  });

  it('appends a new line received over the ws-wsl-diagnostic-line custom event', async () => {
    mockUseApp({ errors: [] });
    render(<ErrorsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/errors/wsl-diagnostics');
    });

    fireEvent(window, new CustomEvent('ws-wsl-diagnostic-line', {
      detail: {
        line: { id: 99, timestamp: '2026-01-01T00:00:00Z', source: 'dmesg', text: 'OOM killed process 42' },
      },
    }));

    await waitFor(() => {
      expect(screen.getByText('OOM killed process 42')).toBeInTheDocument();
    });
  });

  it('filters lines by the search box', async () => {
    mockUseApp({ errors: [] });
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/errors/wsl-diagnostics') {
        return {
          ok: true,
          json: async () => [
            { id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'docker-events', text: 'container kirofactory-worker-1 killed (signal: 15)', containerName: 'kirofactory-worker-1' },
            { id: 2, timestamp: '2026-01-01T00:00:01Z', source: 'dmesg', text: 'OOM killed process 42' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<ErrorsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    await waitFor(() => {
      expect(screen.getByText(/container kirofactory-worker-1 killed/)).toBeInTheDocument();
    });
    expect(screen.getByText('OOM killed process 42')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search logs…'), { target: { value: 'OOM' } });

    expect(screen.queryByText(/container kirofactory-worker-1 killed/)).not.toBeInTheDocument();
    expect(screen.getByText('OOM killed process 42')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 lines match')).toBeInTheDocument();
  });

  it('shows a no-match message when the search query matches nothing', async () => {
    mockUseApp({ errors: [] });
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/errors/wsl-diagnostics') {
        return {
          ok: true,
          json: async () => [
            { id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'dmesg', text: 'something happened' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<ErrorsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    await waitFor(() => {
      expect(screen.getByText('something happened')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Search logs…'), { target: { value: 'nonexistent-xyz' } });

    expect(screen.getByText('No lines match your search.')).toBeInTheDocument();
  });

  it('copies all visible lines to the clipboard, respecting an active search filter', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    mockUseApp({ errors: [] });
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/errors/wsl-diagnostics') {
        return {
          ok: true,
          json: async () => [
            { id: 1, timestamp: '2026-01-01T00:00:00Z', source: 'docker-events', text: 'container kirofactory-worker-1 killed (signal: 15)', containerName: 'kirofactory-worker-1' },
            { id: 2, timestamp: '2026-01-01T00:00:01Z', source: 'dmesg', text: 'OOM killed process 42' },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<ErrorsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'WSL/Docker Logs' }));

    await waitFor(() => {
      expect(screen.getByText('OOM killed process 42')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Search logs…'), { target: { value: 'OOM' } });
    fireEvent.click(screen.getByTitle('Copy all visible lines to clipboard'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain('OOM killed process 42');
    expect(copiedText).not.toContain('kirofactory-worker-1 killed');

    await waitFor(() => {
      expect(screen.getByText('✓ Copied')).toBeInTheDocument();
    });
  });
});
