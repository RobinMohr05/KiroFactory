import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { EasySessionsView } from '../components/EasySessionsView';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [
      { id: 1, name: 'Chat', status: 'running', isPermanent: true, pinned: true, interactive: true, loop: false },
    ],
    setSessions: vi.fn(),
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('EasySessionsView', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/output')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  it('shows the pinned chat session in the list, prefixed distinctly', () => {
    mockUseApp();
    render(<EasySessionsView />);
    expect(screen.getByText(/💬 Chat/)).toBeInTheDocument();
  });

  it('auto-selects the pinned session when nothing is active', async () => {
    const setActiveSessionId = vi.fn();
    mockUseApp({ setActiveSessionId });
    render(<EasySessionsView />);
    await waitFor(() => {
      expect(setActiveSessionId).toHaveBeenCalledWith(1);
    });
  });

  it('lists non-pinned sessions alongside the pinned one', () => {
    mockUseApp({
      sessions: [
        { id: 1, name: 'Chat', status: 'running', isPermanent: true, pinned: true },
        { id: 2, name: 'My loop session', status: 'stopped' },
      ],
      activeSessionId: 1,
    });
    render(<EasySessionsView />);
    expect(screen.getByText(/💬 Chat/)).toBeInTheDocument();
    expect(screen.getByText('My loop session')).toBeInTheDocument();
  });

  it('shows only prompt + runs in the New Session form (no name/agent/model/cwd/MCP toggle fields)', () => {
    mockUseApp({ activeSessionId: 1 });
    render(<EasySessionsView />);

    fireEvent.click(screen.getByText('+ New Session'));

    expect(screen.getByLabelText(/what should it do/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/runs/i)).toBeInTheDocument();

    // MCP toggle fields removed — no longer part of the Easy view
    expect(screen.queryByText('Atlassian')).not.toBeInTheDocument();
    expect(screen.queryByText('Azure DevOps')).not.toBeInTheDocument();
    expect(screen.queryByText('AWS API')).not.toBeInTheDocument();
    expect(screen.queryByText('AWS Docs')).not.toBeInTheDocument();

    // Fields that exist in the full SessionModal but must NOT appear here
    expect(screen.queryByLabelText(/session name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/agent/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/working directory/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^model/i)).not.toBeInTheDocument();
  });

  it('requires a prompt before creating a session', () => {
    mockUseApp({ activeSessionId: 1 });
    render(<EasySessionsView />);

    fireEvent.click(screen.getByText('+ New Session'));
    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    expect(screen.getByText(/describe what you want the session to do/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/sessions', expect.anything());
  });

  it('creates a session with prompt/runs and defaults for everything else, then auto-starts it', async () => {
    const setSessions = vi.fn();
    const setActiveSessionId = vi.fn();
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/sessions' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 42, name: 'Session x', status: 'stopped' }) };
      }
      if (url === '/api/sessions/42/start') {
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes('/output')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ activeSessionId: 1, setSessions, setActiveSessionId });
    render(<EasySessionsView />);

    fireEvent.click(screen.getByText('+ New Session'));
    fireEvent.change(screen.getByLabelText(/what should it do/i), { target: { value: 'Refactor the widget' } });
    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    await waitFor(() => {
      expect(setActiveSessionId).toHaveBeenCalledWith(42);
    });

    const createCall = apiFetchMock.mock.calls.find(([url, opts]) => url === '/api/sessions' && opts?.method === 'POST');
    expect(createCall).toBeTruthy();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.prompt).toBe('Refactor the widget');
    expect(body.runs).toBe(0);
    // mcpConfigOverride is no longer sent — tab-level MCP toggles have been removed
    expect(body.mcpConfigOverride).toBeUndefined();
    // No agent/tabIds/cwd/model fields sent — Easy mode leaves them unset
    expect(body.agent).toBeUndefined();
    expect(body.tabIds).toBeUndefined();
    expect(body.cwd).toBeUndefined();

    expect(apiFetchMock).toHaveBeenCalledWith('/api/sessions/42/start', { method: 'POST' });
  });
});
