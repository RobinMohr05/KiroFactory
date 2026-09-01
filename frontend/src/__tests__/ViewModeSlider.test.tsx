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

  it('clicking a label opens the same pending confirmation as clicking its dot', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    const advancedLabel = screen.getByText('Advanced');
    expect(advancedLabel.tagName).toBe('BUTTON');
    fireEvent.click(advancedLabel);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/switch from easy to advanced/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
  });

  it('clicking the already-committed label does nothing', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText('Easy'));

    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clicking a label while a confirmation is already open does nothing new', () => {
    const onConfirm = vi.fn();
    render(<ViewModeSlider steps={steps} value="easy" onConfirm={onConfirm} />);

    // Open the confirmation via the Advanced dot first.
    fireEvent.click(screen.getByLabelText('Advanced'));
    expect(screen.getByText(/switch from easy to advanced/i)).toBeInTheDocument();

    // Clicking the Easy label while pending must be a no-op.
    fireEvent.click(screen.getByText('Easy'));
    expect(screen.getByText(/switch from easy to advanced/i)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
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

  describe('with 3 stops (Easy/Advanced/Looper)', () => {
    const threeSteps = [
      { value: 'easy' as const, label: 'Easy' },
      { value: 'advanced' as const, label: 'Advanced' },
      { value: 'looper' as const, label: 'Looper' },
    ];

    it('renders all 3 step labels', () => {
      render(<ViewModeSlider steps={threeSteps} value="easy" onConfirm={vi.fn()} />);
      expect(screen.getByText('Easy')).toBeInTheDocument();
      expect(screen.getByText('Advanced')).toBeInTheDocument();
      expect(screen.getByText('Looper')).toBeInTheDocument();
    });

    it('clicking Looper from Easy shows the correct confirmation text', () => {
      render(<ViewModeSlider steps={threeSteps} value="easy" onConfirm={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Looper'));
      expect(screen.getByText(/switch from easy to looper/i)).toBeInTheDocument();
    });

    it('confirms switching to Looper', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      render(<ViewModeSlider steps={threeSteps} value="easy" onConfirm={onConfirm} />);

      fireEvent.click(screen.getByLabelText('Looper'));
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledWith('looper');
      });
    });

    it('marks Looper as active when committed', () => {
      render(<ViewModeSlider steps={threeSteps} value="looper" onConfirm={vi.fn()} />);
      expect(screen.getByText('Looper')).toHaveClass('is-active');
    });
  });
});
