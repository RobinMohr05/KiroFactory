import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Header } from '../components/Header';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ toggleTheme: vi.fn() }),
}));

const mockSetActiveView = vi.fn();

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(AppContext.useApp).mockReturnValue({
      connected: true,
      logout: vi.fn(),
      setActiveView: mockSetActiveView,
      errors: [],
      activeView: 'boards',
    } as any);
    vi.mocked(api.apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ totalCostEur: 1.24 }),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT call fetchMonthlyCredits on ws-session-output events', async () => {
    await act(async () => {
      render(<Header />);
    });

    // Flush the initial fetch microtask
    await act(async () => {
      await Promise.resolve();
    });

    // Clear mock to only track subsequent calls
    vi.mocked(api.apiFetch).mockClear();

    // Dispatch multiple ws-session-output events (the old noisy event)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-output', { detail: {} }));
      window.dispatchEvent(new CustomEvent('ws-session-output', { detail: {} }));
      window.dispatchEvent(new CustomEvent('ws-session-output', { detail: {} }));
    });

    // Flush any pending microtasks
    await act(async () => {
      await Promise.resolve();
    });

    // Should NOT have triggered any API calls from ws-session-output
    expect(vi.mocked(api.apiFetch)).not.toHaveBeenCalled();
  });

  it('calls fetchMonthlyCredits on ws-session-updated events', async () => {
    await act(async () => {
      render(<Header />);
    });

    // Flush the initial fetch microtask
    await act(async () => {
      await Promise.resolve();
    });

    // Clear mock to only track subsequent calls
    vi.mocked(api.apiFetch).mockClear();

    // Dispatch a ws-session-updated event (the less noisy event)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ws-session-updated', { detail: {} }));
    });

    // Flush any pending microtasks
    await act(async () => {
      await Promise.resolve();
    });

    // Should have triggered a fetch call from ws-session-updated
    expect(vi.mocked(api.apiFetch)).toHaveBeenCalledWith('/api/usage/current-month');
  });
});
