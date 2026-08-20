import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MobileTaskList } from '../components/MobileTaskList';
import type { Task, TaskState } from '../types';

const makeTasks = (): Task[] => [
  { id: 1, title: 'Fix login bug', type: 'bug', priority: 1, state: 'todo' as TaskState, isBlocked: false },
  { id: 2, title: 'Add dashboard', type: 'feature', priority: 2, state: 'in-progress' as TaskState, isBlocked: false },
  { id: 3, title: 'Refactor auth', type: 'improvement', priority: 3, state: 'developed' as TaskState, isBlocked: false },
  { id: 4, title: 'Blocked task', type: 'bug', priority: 2, state: 'todo' as TaskState, isBlocked: true, blockedBy: [{ id: 1, title: 'Fix login bug' }] },
  { id: 5, title: 'Done task', type: 'feature', priority: 4, state: 'done' as TaskState, isBlocked: false },
  { id: 6, title: 'Code review task', type: 'improvement', priority: 2, state: 'in-code-review' as TaskState, isBlocked: false },
  { id: 7, title: 'Reviewed task', type: 'feature', priority: 3, state: 'reviewed' as TaskState, isBlocked: false },
  { id: 8, title: 'QA task', type: 'bug', priority: 1, state: 'in-qa' as TaskState, isBlocked: false },
];

describe('MobileTaskList', () => {
  const onTaskClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a vertical list of task cards', () => {
    render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
    // By default, "done" is excluded so 7 of 8 tasks are visible
    const cards = screen.getAllByRole('article');
    expect(cards.length).toBe(7);
  });

  it('shows priority color bar, title, status badge, and type badge on each card', () => {
    render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
    const card = screen.getByRole('article', { name: /Fix login bug/i });
    expect(card).toBeInTheDocument();
    // Status badge showing the state
    expect(within(card).getByText('todo')).toBeInTheDocument();
    // Type badge
    expect(within(card).getByText('Bug')).toBeInTheDocument();
    // Priority indicator
    expect(card).toHaveAttribute('data-priority', '1');
  });

  it('shows blocked indicator on blocked tasks', () => {
    render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
    const blockedCard = screen.getByRole('article', { name: /Blocked task/i });
    expect(within(blockedCard).getByText(/⛔ Blocked/)).toBeInTheDocument();
  });

  it('calls onTaskClick with the task when a card is tapped', () => {
    const tasks = makeTasks();
    render(<MobileTaskList tasks={tasks} onTaskClick={onTaskClick} />);
    const card = screen.getByRole('article', { name: /Fix login bug/i });
    fireEvent.click(card);
    expect(onTaskClick).toHaveBeenCalledWith(tasks[0]);
  });

  describe('filter chips', () => {
    it('renders a chip for each column/status', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      expect(screen.getByRole('button', { name: /todo/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /in-progress/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /developed/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /in-code-review/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reviewed/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /in-qa/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^done/i })).toBeInTheDocument();
    });

    it('defaults to all chips active except "done"', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      const doneChip = screen.getByRole('button', { name: /^done/i });
      expect(doneChip).toHaveAttribute('aria-pressed', 'false');
      const todoChip = screen.getByRole('button', { name: /todo/i });
      expect(todoChip).toHaveAttribute('aria-pressed', 'true');
    });

    it('toggling a chip hides/shows tasks in that state', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      // Initially todo tasks are visible
      expect(screen.getByRole('article', { name: /Fix login bug/i })).toBeInTheDocument();
      // Toggle off the todo chip
      const todoChip = screen.getByRole('button', { name: /todo/i });
      fireEvent.click(todoChip);
      // Now todo tasks should be hidden
      expect(screen.queryByRole('article', { name: /Fix login bug/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('article', { name: /Blocked task/i })).not.toBeInTheDocument();
    });

    it('toggling "done" chip on shows done tasks', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      // Initially done tasks are hidden
      expect(screen.queryByRole('article', { name: /Done task/i })).not.toBeInTheDocument();
      // Toggle on the done chip
      const doneChip = screen.getByRole('button', { name: /^done/i });
      fireEvent.click(doneChip);
      // Now done tasks should be visible
      expect(screen.getByRole('article', { name: /Done task/i })).toBeInTheDocument();
    });

    it('multiple chips can be active simultaneously', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      // Both todo and in-progress are active by default
      expect(screen.getByRole('article', { name: /Fix login bug/i })).toBeInTheDocument();
      expect(screen.getByRole('article', { name: /Add dashboard/i })).toBeInTheDocument();
    });

    it('shows task count per chip', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      // 'todo' has 2 tasks (id 1 and id 4)
      const todoChip = screen.getByRole('button', { name: /todo/i });
      expect(todoChip).toHaveTextContent('2');
    });
  });

  describe('sort options', () => {
    it('renders a sort button', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument();
    });

    it('opens a sort popover with options when sort button is clicked', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      const sortBtn = screen.getByRole('button', { name: /sort/i });
      fireEvent.click(sortBtn);
      expect(screen.getByRole('button', { name: /priority/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /created date/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /alphabetical/i })).toBeInTheDocument();
    });

    it('sorts by priority by default (lower priority number first)', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      const cards = screen.getAllByRole('article');
      // P1 tasks first, then P2, then P3
      expect(cards[0]).toHaveAttribute('aria-label', expect.stringContaining('Fix login bug'));
    });

    it('sorts alphabetically when selected', () => {
      render(<MobileTaskList tasks={makeTasks()} onTaskClick={onTaskClick} />);
      const sortBtn = screen.getByRole('button', { name: /sort/i });
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /alphabetical/i }));
      const cards = screen.getAllByRole('article');
      // "Add dashboard" comes first alphabetically among visible tasks
      expect(cards[0]).toHaveAttribute('aria-label', expect.stringContaining('Add dashboard'));
    });

    it('sorts by created date when selected', () => {
      const tasks = makeTasks().map((t, i) => ({ ...t, createdAt: new Date(2024, 0, i + 1).toISOString() }));
      render(<MobileTaskList tasks={tasks} onTaskClick={onTaskClick} />);
      const sortBtn = screen.getByRole('button', { name: /sort/i });
      fireEvent.click(sortBtn);
      fireEvent.click(screen.getByRole('button', { name: /created date/i }));
      const cards = screen.getAllByRole('article');
      // Most recent first (highest index = most recent date, but "done" excluded)
      // Task 8 (QA task, Jan 8) is most recent among visible
      expect(cards[0]).toHaveAttribute('aria-label', expect.stringContaining('QA task'));
    });
  });
});
