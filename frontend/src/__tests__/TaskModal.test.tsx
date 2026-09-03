import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';
import type { Task } from '../types';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
  TYPE_CLASSES: {
    improvement: 'badge-improvement',
    bug: 'badge-bug',
    feature: 'badge-feature',
  },
  ORIGIN_ICONS: {
    user: '\u{1F464}',
    ai: '\u{1F916}',
    'user-assisted': '\u{1F91D}',
  },
}));

import { TaskModal } from '../components/TaskModal';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    currentTabId: 1,
    setTasks: vi.fn(),
    pendingOps: { current: new Set<string>() },
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('TaskModal - group ID field', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  const groupedTask: Task = {
    id: 1555,
    title: 'Replace free-text model input with restricted searchable combobox',
    type: 'improvement',
    priority: 3,
    state: 'in-progress',
    origin: 'ai',
    branch: 'bug/#1554_wire-session-model-selection-through-to-containerized-worker',
    pullRequestUrl: null,
    groupId: 'session-model-fix',
    dependsOn: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseApp();
    apiFetchMock = vi.mocked(api.apiFetch);
    // Dependency picker's task-list fetch on mount
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  });

  it('does not render a Group ID field when creating a new task', async () => {
    render(<TaskModal task={null} onClose={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByLabelText('Group ID')).not.toBeInTheDocument();
  });

  it('renders the Group ID field pre-filled when editing a grouped task', async () => {
    render(<TaskModal task={groupedTask} onClose={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const input = screen.getByLabelText('Group ID') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('session-model-fix');
  });

  it('renders an empty Group ID field when editing an ungrouped task', async () => {
    const ungrouped: Task = { ...groupedTask, groupId: null };
    render(<TaskModal task={ungrouped} onClose={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const input = screen.getByLabelText('Group ID') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('sends the edited groupId in the PUT request body', async () => {
    render(<TaskModal task={groupedTask} onClose={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    const input = screen.getByLabelText('Group ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new-group-name' } });

    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...groupedTask, groupId: 'new-group-name' }) });

    fireEvent.click(screen.getByRole('button', { name: 'Update Task' }));

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(([, opts]) => opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1].body as string);
      expect(body.groupId).toBe('new-group-name');
    });
  });

  it('sends groupId as null when the field is cleared', async () => {
    render(<TaskModal task={groupedTask} onClose={() => {}} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());

    const input = screen.getByLabelText('Group ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  ' } });

    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...groupedTask, groupId: null }) });

    fireEvent.click(screen.getByRole('button', { name: 'Update Task' }));

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(([, opts]) => opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1].body as string);
      expect(body.groupId).toBeNull();
    });
  });
});
