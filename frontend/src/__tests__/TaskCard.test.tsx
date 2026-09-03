import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from '../components/TaskCard';
import type { Task } from '../types';

describe('TaskCard', () => {
  const baseTask: Task = {
    id: 1,
    title: 'Fix login bug',
    type: 'bug',
    priority: 1,
    state: 'todo',
    origin: 'user',
  };

  it('renders the task title', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} />);
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('renders the priority', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('renders the type badge', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} />);
    expect(screen.getByText('Bug')).toBeInTheDocument();
  });

  it('renders blocked badge when task is blocked', () => {
    const blockedTask: Task = {
      ...baseTask,
      isBlocked: true,
      blockedBy: [{ id: 2, title: 'Other task' }],
    };
    render(<TaskCard task={blockedTask} onClick={() => {}} />);
    expect(screen.getByText('⛔ Blocked')).toBeInTheDocument();
  });

  it('does not render blocked badge when task is not blocked', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} />);
    expect(screen.queryByText('⛔ Blocked')).not.toBeInTheDocument();
  });

  it('renders group badge when task has a groupId', () => {
    const groupedTask: Task = { ...baseTask, groupId: 'session-model-fix' };
    render(<TaskCard task={groupedTask} onClick={() => {}} />);
    expect(screen.getByText('🔗 session-model-fix')).toBeInTheDocument();
  });

  it('does not render group badge when task has no groupId', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} />);
    expect(screen.queryByText(/🔗/)).not.toBeInTheDocument();
  });

  it('has correct data attributes', () => {
    const { container } = render(<TaskCard task={baseTask} onClick={() => {}} />);
    const card = container.querySelector('.task-card');
    expect(card).toHaveAttribute('data-task-id', '1');
    expect(card).toHaveAttribute('data-priority', '1');
    expect(card).toHaveAttribute('data-blocked', 'false');
  });

  it('is draggable', () => {
    const { container } = render(<TaskCard task={baseTask} onClick={() => {}} />);
    const card = container.querySelector('.task-card');
    expect(card).toHaveAttribute('draggable', 'true');
  });

  describe('disableInteraction prop', () => {
    it('defaults to draggable when disableInteraction is omitted', () => {
      const { container } = render(<TaskCard task={baseTask} onClick={() => {}} />);
      const card = container.querySelector('.task-card');
      expect(card).toHaveAttribute('draggable', 'true');
    });

    it('defaults to draggable when disableInteraction is false', () => {
      const { container } = render(<TaskCard task={baseTask} onClick={() => {}} disableInteraction={false} />);
      const card = container.querySelector('.task-card');
      expect(card).toHaveAttribute('draggable', 'true');
    });

    it('sets draggable=false when disableInteraction is true', () => {
      const { container } = render(<TaskCard task={baseTask} onClick={() => {}} disableInteraction={true} />);
      const card = container.querySelector('.task-card');
      expect(card).toHaveAttribute('draggable', 'false');
    });
  });
});
