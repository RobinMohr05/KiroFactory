import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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
      const result = render(<Header />);
      container = result.container;
    });
    expect(container!.querySelector('.connection-status')).toBeNull();
  });

  it('renders a hamburger menu button', async () => {
    await act(async () => {
      render(<Header />);
    });
    expect(screen.getByLabelText(/open menu/i)).toBeInTheDocument();
  });

  it('opens the MobileDrawer when hamburger is clicked', async () => {
    await act(async () => {
      render(<Header />);
    });
    const hamburger = screen.getByLabelText(/open menu/i);
    await act(async () => {
      fireEvent.click(hamburger);
    });
    // The drawer should now be visible (it contains nav links)
    expect(screen.getByRole('button', { name: /^sessions$/i })).toBeInTheDocument();
  });
});
