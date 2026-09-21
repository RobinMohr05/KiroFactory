import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock('../components/AutoScalerPanel', () => ({
  AutoScalerPanel: () => <div data-testid="autoscaler-panel">AutoScalerPanel</div>,
  AutoScalerDetailView: ({ autoScaler }: { autoScaler: { name: string } }) => (
    <div data-testid="autoscaler-detail-panel">{autoScaler.name}</div>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
  };
});

import { SessionsPanel } from '../components/SessionsPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    sessions: [],
    setSessions: vi.fn(),
    currentTabId: 1,
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    tabs: [{ id: 1, name: 'VCH' }, { id: 2, name: 'TecFactory' }],
    pendingOps: { current: new Set() },
    errors: [],
    tasks: [],
    setActiveView: vi.fn(),
    setHighlightedTaskId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('SessionsPanel - Bind permanent Chat session to active tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as any);
  });

  it('on mount, binds a stopped permanent session to the current tab via PUT /tabs (no stop needed)', async () => {
    const setSessions = vi.fn();
    mockUseApp({
      sessions: [
        { id: 1, name: 'Chat', agent: '', status: 'stopped', isPermanent: true, tabIds: [5] },
      ],
      currentTabId: 2,
      activeSessionId: 1,
      setSessions,
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/sessions/1/tabs', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ tabIds: [2] }),
      }));
    });

    // Stopped session must NOT be stopped
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/sessions/1/stop', expect.anything());

    // Optimistic update applied
    expect(setSessions).toHaveBeenCalled();
  });

  it('stops a running permanent session before updating its tabs, awaiting the stop first', async () => {
    const calls: string[] = [];
    vi.mocked(api.apiFetch).mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: async () => [] }) as any;
    });

    mockUseApp({
      sessions: [
        { id: 3, name: 'Chat', agent: '', status: 'running', isPermanent: true, tabIds: [5] },
      ],
      currentTabId: 2,
      activeSessionId: 3,
      setSessions: vi.fn(),
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await waitFor(() => {
      expect(calls).toContain('/api/sessions/3/tabs');
    });

    const stopIdx = calls.indexOf('/api/sessions/3/stop');
    const tabsIdx = calls.indexOf('/api/sessions/3/tabs');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(tabsIdx).toBeGreaterThan(stopIdx);
  });

  it('proceeds with PUT /tabs even if POST /stop fails', async () => {
    vi.mocked(api.apiFetch).mockImplementation((url: string) => {
      if (url.endsWith('/stop')) {
        return Promise.reject(new Error('network error')) as any;
      }
      return Promise.resolve({ ok: true, json: async () => [] }) as any;
    });

    mockUseApp({
      sessions: [
        { id: 4, name: 'Chat', agent: '', status: 'running', isPermanent: true, tabIds: [5] },
      ],
      currentTabId: 2,
      activeSessionId: 4,
      setSessions: vi.fn(),
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/sessions/4/tabs', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ tabIds: [2] }),
      }));
    });
  });

  it('does nothing when there is no permanent session', async () => {
    mockUseApp({
      sessions: [
        { id: 2, name: 'Dev Agent', agent: 'developer-agent', status: 'running', isPermanent: false, tabIds: [1] },
      ],
      currentTabId: 2,
      activeSessionId: 2,
      setSessions: vi.fn(),
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    // Give any effects a chance to run
    await Promise.resolve();

    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/sessions/2/tabs', expect.anything());
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/sessions/2/stop', expect.anything());
  });

  it('does nothing when currentTabId is null', async () => {
    mockUseApp({
      sessions: [
        { id: 1, name: 'Chat', agent: '', status: 'stopped', isPermanent: true, tabIds: [5] },
      ],
      currentTabId: null,
      activeSessionId: 1,
      setSessions: vi.fn(),
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await Promise.resolve();

    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/sessions/1/tabs', expect.anything());
  });

  it('does not change tabIds of non-permanent sessions', async () => {
    mockUseApp({
      sessions: [
        { id: 1, name: 'Chat', agent: '', status: 'stopped', isPermanent: true, tabIds: [5] },
        { id: 2, name: 'Dev Agent', agent: 'developer-agent', status: 'stopped', isPermanent: false, tabIds: [1] },
      ],
      currentTabId: 2,
      activeSessionId: 1,
      setSessions: vi.fn(),
    });

    render(<MemoryRouter><SessionsPanel /></MemoryRouter>);

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/sessions/1/tabs', expect.anything());
    });

    // Only the permanent session's tabs endpoint should be called
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/sessions/2/tabs', expect.anything());
  });
});
