import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewTabs } from '../components/ViewTabs';
import * as AppContext from '../context/AppContext';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

describe('ViewTabs', () => {
  const mockSetActiveView = vi.fn();

  beforeEach(() => {
    mockSetActiveView.mockClear();
  });

  it('shows error badge when there are unread errors', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [
        { id: 1, message: 'err', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: false },
        { id: 2, message: 'err2', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: true },
      ],
    } as any);

    render(<ViewTabs activeView="boards" setActiveView={mockSetActiveView} />);
    // Only 1 error has taskCreated=false
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('does not show error badge when all errors are dismissed', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [
        { id: 1, message: 'err', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: true },
      ],
    } as any);

    render(<ViewTabs activeView="boards" setActiveView={mockSetActiveView} />);
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  it('calls setActiveView when a tab is clicked', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({ errors: [] } as any);

    render(<ViewTabs activeView="boards" setActiveView={mockSetActiveView} />);
    fireEvent.click(screen.getByRole('tab', { name: /sessions/i }));
    expect(mockSetActiveView).toHaveBeenCalledWith('sessions');
  });

  it('marks the active tab with the active class', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({ errors: [] } as any);

    render(<ViewTabs activeView="agents" setActiveView={mockSetActiveView} />);
    const agentsTab = screen.getByRole('tab', { name: /agents/i });
    expect(agentsTab.classList.contains('active')).toBe(true);
  });
});
