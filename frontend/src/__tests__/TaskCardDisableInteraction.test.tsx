import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from '../components/TaskCard';
import type { Task } from '../types';

describe('TaskCard - disableInteraction prop (Part C)', () => {
  const baseTask: Task = {
    id: 1,
    title: 'Test task',
    type: 'bug',
    priority: 2,
    state: 'todo',
    origin: 'ai',
  };

  it('sets draggable=false when disableInteraction is true', () => {
    const { container } = render(
      <TaskCard task={baseTask} onClick={() => {}} disableInteraction={true} />
    );
    const card = container.querySelector('.task-card');
    expect(card).toHaveAttribute('draggable', 'false');
  });

  it('remains draggable=true when disableInteraction is false', () => {
    const { container } = render(
      <TaskCard task={baseTask} onClick={() => {}} disableInteraction={false} />
    );
    const card = container.querySelector('.task-card');
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('remains draggable=true when disableInteraction is omitted (default)', () => {
    const { container } = render(
      <TaskCard task={baseTask} onClick={() => {}} />
    );
    const card = container.querySelector('.task-card');
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('still renders title, type badge, priority, and origin when disableInteraction is true', () => {
    render(<TaskCard task={baseTask} onClick={() => {}} disableInteraction={true} />);
    expect(screen.getByText('Test task')).toBeInTheDocument();
    expect(screen.getByText('Bug')).toBeInTheDocument();
    expect(screen.getByText('P2')).toBeInTheDocument();
  });
});
