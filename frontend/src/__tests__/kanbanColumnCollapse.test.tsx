import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksPanel } from '../components/TasksPanel';
import * as AppContext from '../context/AppContext';
import * as MobileBreakpoint from '../hooks/useMobileBreakpoint';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../hooks/useMobileBreakpoint', () => ({
  useMobileBreakpoint: vi.fn(),
}));

// Mock apiFetch so nested modals don't make real requests
vi.mock('../utils/api', async () => {
  const actual = await vi.importActual<typeof import('../utils/api')>('../utils/api');
  return {
    ...actual,
    apiFetch: vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({}) })),
  };
});

const STORAGE_KEY = 'kanban-collapsed-columns';

const baseMockContext = {
  tasks: [
    { id: 1, title: 'Todo task', type: 'bug', priority: 1, state: 'todo', isBlocked: false },
    { id: 2, title: 'InProgress task', type: 'feature', priority: 2, state: 'in-progress', isBlocked: false },
    { id: 3, title: 'Done task', type: 'improvement', priority: 3, state: 'done', isBlocked: false },
  ],
  setTasks: vi.fn(),
  currentSort: 'priority' as const,
  setCurrentSort: vi.fn(),
  currentTabId: 1,
  tabs: [{ id: 1, name: 'Test Tab', repositoryUrl: 'https://github.com/test/repo' }],
  fetchTabTasks: vi.fn(),
  pendingOps: { current: new Set() },
  highlightedTaskId: null,
  setHighlightedTaskId: vi.fn(),
};

function columnFor(container: HTMLElement, state: string): HTMLElement {
  const col = container.querySelector(`.column[data-state="${state}"]`);
  return col as HTMLElement;
}

describe('Kanban collapsible To Do / Done columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(AppContext.useApp).mockReturnValue(baseMockContext as any);
    vi.mocked(MobileBreakpoint.useMobileBreakpoint).mockReturnValue(false);
  });

  it('renders all columns expanded by default (no localStorage state)', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(container.querySelector('.column-collapsed')).toBeNull();
    // Cards are visible for todo and done
    expect(screen.getByText('Todo task')).toBeInTheDocument();
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('shows a collapse toggle only on todo and done columns', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(columnFor(container, 'todo').querySelector('.column-collapse-toggle')).not.toBeNull();
    expect(columnFor(container, 'done').querySelector('.column-collapse-toggle')).not.toBeNull();
    for (const state of ['in-progress', 'developed', 'in-code-review', 'reviewed', 'in-qa']) {
      expect(columnFor(container, state).querySelector('.column-collapse-toggle')).toBeNull();
    }
  });

  it('collapsing Done hides its cards and marks the column collapsed', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const toggle = columnFor(container, 'done').querySelector('.column-collapse-toggle') as HTMLElement;
    fireEvent.click(toggle);
    const doneCol = columnFor(container, 'done');
    expect(doneCol.classList.contains('column-collapsed')).toBe(true);
    expect(screen.queryByText('Done task')).toBeNull();
    // Todo remains expanded and its cards visible
    expect(columnFor(container, 'todo').classList.contains('column-collapsed')).toBe(false);
    expect(screen.getByText('Todo task')).toBeInTheDocument();
  });

  it('toggle reflects state via aria-expanded and aria-label', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const toggle = columnFor(container, 'todo').querySelector('.column-collapse-toggle') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toMatch(/collapse/i);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toMatch(/expand/i);
  });

  it('expands a collapsed column again on second click', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const toggle = columnFor(container, 'done').querySelector('.column-collapse-toggle') as HTMLElement;
    fireEvent.click(toggle);
    expect(screen.queryByText('Done task')).toBeNull();
    fireEvent.click(toggle);
    expect(columnFor(container, 'done').classList.contains('column-collapsed')).toBe(false);
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('persists collapsed state to localStorage under a global key', () => {
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    const toggle = columnFor(container, 'done').querySelector('.column-collapse-toggle') as HTMLElement;
    fireEvent.click(toggle);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    expect(stored).toContain('done');
    expect(stored).not.toContain('todo');
  });

  it('restores collapsed state from localStorage across a remount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['done']));
    const { container } = render(<MemoryRouter><TasksPanel /></MemoryRouter>);
    expect(columnFor(container, 'done').classList.contains('column-collapsed')).toBe(true);
    expect(screen.queryByText('Done task')).toBeNull();
    expect(columnFor(container, 'todo').classList.contains('column-collapsed')).toBe(false);
  });
});

describe('Kanban collapse styles', () => {
  it('.kanban uses a CSS custom property or explicit tracks for grid columns', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');
    // A collapsed-column rule must exist that reads as narrow (content-sized) and rotates title
    expect(css).toMatch(/\.column-collapsed/);
    expect(css).toMatch(/writing-mode:\s*vertical/);
  });
});
