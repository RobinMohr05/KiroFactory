import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  describe('auto-close on viewport resize past 480px', () => {
    let mockMql: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockMql = {
        matches: true, // initially ≤480px (mobile)
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('matchMedia', vi.fn(() => mockMql));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('calls onClose when viewport exceeds 480px while drawer is open', () => {
      render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      // Verify the listener was registered
      expect(mockMql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

      // Get the registered handler and simulate viewport resizing past 480px
      const handler = mockMql.addEventListener.mock.calls[0][1];
      mockMql.matches = false;
      act(() => {
        handler({ matches: false });
      });

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('does not call onClose when viewport stays within 480px', () => {
      render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      // Get the registered handler and simulate a change event where still ≤480px
      const handler = mockMql.addEventListener.mock.calls[0][1];
      act(() => {
        handler({ matches: true });
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('cleans up the matchMedia listener on unmount', () => {
      const { unmount } = render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      unmount();

      expect(mockMql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });
  });

  describe('Escape key dismissal', () => {
    it('calls onClose when Escape key is pressed while drawer is open', () => {
      render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('does not call onClose for other keys', () => {
      render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      act(() => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('does not register keydown listener when drawer is closed', () => {
      const addEventSpy = vi.spyOn(document, 'addEventListener');
      render(<MobileDrawer open={false} onClose={mockOnClose} monthlyCredits={0} />);

      // Should not have added a keydown listener
      const keydownCalls = addEventSpy.mock.calls.filter(([event]) => event === 'keydown');
      expect(keydownCalls).toHaveLength(0);

      addEventSpy.mockRestore();
    });

    it('cleans up keydown listener on unmount', () => {
      const removeEventSpy = vi.spyOn(document, 'removeEventListener');
      const { unmount } = render(<MobileDrawer open={true} onClose={mockOnClose} monthlyCredits={0} />);

      unmount();

      const keydownCalls = removeEventSpy.mock.calls.filter(([event]) => event === 'keydown');
      expect(keydownCalls.length).toBeGreaterThan(0);

      removeEventSpy.mockRestore();
    });
  });
});
