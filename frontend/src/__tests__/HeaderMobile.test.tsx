import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

describe('Header - mobile scaffold', () => {
  const mockSetActiveView = vi.fn();

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

  it('does not render a connection-status element', async () => {
    let container: HTMLElement;
    await act(async () => {
      const result = render(<MemoryRouter><Header /></MemoryRouter>);
      container = result.container;
    });
    expect(container!.querySelector('.connection-status')).toBeNull();
  });

  it('renders a hamburger menu button', async () => {
    await act(async () => {
      render(<MemoryRouter><Header /></MemoryRouter>);
    });
    expect(screen.getByLabelText(/open menu/i)).toBeInTheDocument();
  });

  it('opens the MobileDrawer when hamburger is clicked', async () => {
    await act(async () => {
      render(<MemoryRouter><Header /></MemoryRouter>);
    });
    const hamburger = screen.getByLabelText(/open menu/i);
    await act(async () => {
      fireEvent.click(hamburger);
    });
    // The drawer should now be visible (it contains nav links)
    expect(screen.getByRole('button', { name: /^sessions$/i })).toBeInTheDocument();
  });

  it('passes a stable onClose callback to MobileDrawer (useCallback)', async () => {
    // Spy on MobileDrawer to capture its props across renders
    const drawerModule = await import('../components/MobileDrawer');
    const drawerSpy = vi.spyOn(drawerModule, 'MobileDrawer');

    const { rerender } = await act(async () => {
      return render(<MemoryRouter><Header /></MemoryRouter>);
    });

    // Trigger a re-render by clicking hamburger to open drawer
    const hamburger = screen.getByLabelText(/open menu/i);
    await act(async () => {
      fireEvent.click(hamburger);
    });

    // Get the onClose from the first render that had the drawer open
    const firstOnClose = drawerSpy.mock.calls.find(
      (call) => call[0].open === true
    )?.[0].onClose;

    // Trigger another re-render (advance timer to cause credit refetch)
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    // Get the onClose from the latest render
    const latestOnClose = drawerSpy.mock.calls[drawerSpy.mock.calls.length - 1][0].onClose;

    // They should be the same reference (useCallback ensures stability)
    expect(firstOnClose).toBe(latestOnClose);

    drawerSpy.mockRestore();
  });
});
