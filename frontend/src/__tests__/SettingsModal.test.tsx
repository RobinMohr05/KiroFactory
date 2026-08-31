import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));

import { SettingsModal } from '../components/SettingsModal';

describe('SettingsModal — Interface Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  it('renders the Interface Mode slider outside the Danger Zone, defaulting to Easy', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01' },
      setUiViewMode: vi.fn(),
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    expect(screen.getByText('Interface Mode')).toBeInTheDocument();
    // "Easy" should appear as the slider's active step when uiViewMode is unset (defaults to easy)
    const easyLabel = screen.getAllByText('Easy').find(el => el.className.includes('view-mode-slider-label'));
    expect(easyLabel).toHaveClass('is-active');
  });

  it('switching requires confirmation and calls setUiViewMode only on Confirm', async () => {
    const setUiViewMode = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode,
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Advanced'));
    expect(setUiViewMode).not.toHaveBeenCalled();
    expect(screen.getByText(/switch from easy to advanced/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => {
      expect(setUiViewMode).toHaveBeenCalledWith('advanced');
    });
  });

  it('does not place the Interface Mode section inside the Danger Zone', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode: vi.fn(),
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    const dangerZone = document.querySelector('.settings-danger-zone');
    expect(dangerZone).not.toBeNull();
    expect(dangerZone?.querySelector('.view-mode-slider')).toBeNull();
  });

  it('renders 3 slider stops: Easy, Advanced, Looper', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode: vi.fn(),
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    // All three labels should be rendered
    expect(screen.getAllByText('Easy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Advanced').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Looper').length).toBeGreaterThan(0);
  });

  it('switching from Easy to Looper persists via setUiViewMode', async () => {
    const setUiViewMode = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode,
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Looper'));
    expect(setUiViewMode).not.toHaveBeenCalled();
    expect(screen.getByText(/switch from easy to looper/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => {
      expect(setUiViewMode).toHaveBeenCalledWith('looper');
    });
  });

  it('mode description mentions all three modes', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode: vi.fn(),
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    const description = document.querySelector('.credentials-description');
    expect(description?.textContent).toContain('Easy');
    expect(description?.textContent).toContain('Advanced');
    expect(description?.textContent).toContain('Looper');
  });

  it('confirmation prompt warns that switching will stop all running sessions', () => {
    vi.mocked(AppContext.useApp).mockReturnValue({
      user: { id: 1, email: 'a@b.com', createdAt: '2024-01-01', uiViewMode: 'easy' },
      setUiViewMode: vi.fn(),
    } as any);

    render(<SettingsModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Advanced'));

    const confirmText = screen.getByText(/stop all your running sessions/i);
    expect(confirmText).toBeInTheDocument();
  });
});
