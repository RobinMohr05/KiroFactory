import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileDrawer } from '../components/MobileDrawer';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(() => ({
    errors: [],
    activeView: 'boards',
    setActiveView: vi.fn(),
    logout: vi.fn(),
  })),
}));

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ toggleTheme: vi.fn() }),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ totalCostEur: 1.5 }) }),
}));

import * as AppContext from '../context/AppContext';

describe('MobileDrawer', () => {
  const mockSetActiveView = vi.fn();
  const mockLogout = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [],
      activeView: 'boards',
      setActiveView: mockSetActiveView,
      logout: mockLogout,
    } as any);
  });

  it('renders all 5 view navigation links when open', () => {
    render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={1.5} />);

    expect(screen.getByRole('button', { name: /^tasks$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sessions$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^errors$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^usage$/i })).toBeInTheDocument();
  });

  it('renders cost badge, theme toggle, settings, and logout in the drawer', () => {
    render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={2.5} />);

    // Cost badge text
    expect(screen.getByText(/EUR 2\.50/)).toBeInTheDocument();
    // Theme toggle
    expect(screen.getByLabelText(/toggle dark mode/i)).toBeInTheDocument();
    // Settings button
    expect(screen.getByLabelText(/profile & settings/i)).toBeInTheDocument();
    // Logout button
    expect(screen.getByLabelText(/sign out/i)).toBeInTheDocument();
  });

  it('calls onClose and setActiveView when a nav link is tapped', () => {
    render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

    fireEvent.click(screen.getByRole('button', { name: /^sessions$/i }));
    expect(mockSetActiveView).toHaveBeenCalledWith('sessions');
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

    const backdrop = screen.getByTestId('drawer-backdrop');
    fireEvent.click(backdrop);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('does not render when open is false', () => {
    const { container } = render(<MobileDrawer open={false} onClose={mockOnClose} monthlyCredits={0} />);
    expect(container.querySelector('.mobile-drawer')).not.toBeInTheDocument();
  });

  it('marks the active view link as active', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [],
      activeView: 'agents',
      setActiveView: mockSetActiveView,
      logout: mockLogout,
    } as any);

    render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

    const agentsBtn = screen.getByRole('button', { name: /^agents$/i });
    expect(agentsBtn.className).toContain('active');
  });
});
