import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ViewTabs } from '../components/ViewTabs';
import * as AppContext from '../context/AppContext';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('ViewTabs', () => {
  const mockSetActiveView = vi.fn();

  beforeEach(() => {
    mockSetActiveView.mockClear();
    mockNavigate.mockClear();
  });

  it('shows error badge when there are unread errors', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [
        { id: 1, message: 'err', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: false },
        { id: 2, message: 'err2', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: true },
      ],
      activeView: 'boards',
      setActiveView: mockSetActiveView,
    } as any);

    render(<MemoryRouter><ViewTabs /></MemoryRouter>);
    // Only 1 error has taskCreated=false — badge shown inside the Logs tab
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('does not show error badge when all errors are dismissed', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [
        { id: 1, message: 'err', context: '', agent: 'a', sessionName: 's', timestamp: '', taskCreated: true },
      ],
      activeView: 'boards',
      setActiveView: mockSetActiveView,
    } as any);

    render(<MemoryRouter><ViewTabs /></MemoryRouter>);
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  it('navigates when a different tab is clicked', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [],
      activeView: 'boards',
      setActiveView: mockSetActiveView,
    } as any);

    render(<MemoryRouter><ViewTabs /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(mockNavigate).toHaveBeenCalledWith('/sessions');
  });

  it('reflects the active view as the selected tab', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      errors: [],
      activeView: 'agents',
      setActiveView: mockSetActiveView,
    } as any);

    render(<MemoryRouter><ViewTabs /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'false');
  });
});
