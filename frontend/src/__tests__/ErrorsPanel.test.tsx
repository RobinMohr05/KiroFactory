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
});
