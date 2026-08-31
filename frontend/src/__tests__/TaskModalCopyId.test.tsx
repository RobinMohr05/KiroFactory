import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { TaskModal } from '../components/TaskModal';
import type { Task } from '../types';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    currentTabId: 1,
    setTasks: vi.fn(),
    pendingOps: { current: new Set() },
    tabs: [{ id: 1, name: 'Test Tab' }],
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

const baseTask: Task = {
  id: 42,
  title: 'Test task',
  type: 'bug',
  priority: 2,
  state: 'todo',
  origin: 'user',
};

describe('TaskModal — copyable task ID', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    apiFetchMock = vi.mocked(api.apiFetch);
    // Mock fetch for dependency picker (fetches all tasks on mount)
    apiFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows #<id> button when editing an existing task', () => {
    mockUseApp();
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Copy task ID' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('#42');
  });

  it('does not show an ID button when creating a new task', () => {
    mockUseApp();
    render(<TaskModal task={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Copy task ID' })).not.toBeInTheDocument();
  });

  it('copies the numeric task ID (no # prefix) to clipboard on click', async () => {
    mockUseApp();
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Copy task ID' });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('42');
  });

  it('shows "Copied!" text after clicking, then reverts after ~1200ms', async () => {
    mockUseApp();
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Copy task ID' });

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveTextContent('Copied!');
    expect(btn).toHaveClass('copied');

    // Advance past the 1200ms timeout
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(btn).toHaveTextContent('#42');
    expect(btn).not.toHaveClass('copied');
  });

  it('keeps idCopied false if clipboard.writeText rejects', async () => {
    mockUseApp();
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('denied'));
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Copy task ID' });

    await act(async () => {
      fireEvent.click(btn);
    });
    // Should still show the ID, not "Copied!"
    expect(btn).toHaveTextContent('#42');
    expect(btn).not.toHaveClass('copied');
  });

  it('has the correct title attribute for tooltip', () => {
    mockUseApp();
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Copy task ID' });
    expect(btn).toHaveAttribute('title', 'Click to copy task ID');
  });

  it('still shows the "Edit Task" heading alongside the ID', () => {
    mockUseApp();
    render(<TaskModal task={baseTask} onClose={vi.fn()} />);
    expect(screen.getByText('Edit Task')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
  });

  it('still shows "New Task" heading when creating, with no ID element', () => {
    mockUseApp();
    render(<TaskModal task={null} onClose={vi.fn()} />);
    expect(screen.getByText('New Task')).toBeInTheDocument();
    expect(screen.queryByText('#42')).not.toBeInTheDocument();
  });
});
