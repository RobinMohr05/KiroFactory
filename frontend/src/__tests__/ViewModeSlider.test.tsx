import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ViewModeSlider } from '../components/ViewModeSlider';

describe('ViewModeSlider', () => {
  const steps = [
    { value: 'easy' as const, label: 'Easy' },
    { value: 'advanced' as const, label: 'Advanced' },
  ];

  it('renders both step labels and marks the committed value active', () => {
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={vi.fn()} />);
    expect(screen.getByText('Easy')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    expect(screen.getByText('Easy')).toHaveClass('is-active');
  });

  it('does not call onConfirm just from clicking a stop — shows a pending confirmation instead', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Advanced'));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/switch from easy to advanced/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('calls onConfirm only after clicking Confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('advanced');
    });
  });

  it('Cancel discards the pending change without calling onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    // Should have reverted back to the committed "Easy" being active
    expect(screen.getByText('Easy')).toHaveClass('is-active');
  });

  it('shows an error message and does not clear the pending state if onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Network error'));
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    // Pending confirmation should still be visible so the user can retry
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
  });

  it('clicking the already-committed stop does not open a confirmation', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Easy'));

    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('Escape cancels a pending confirmation', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Advanced'));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
