import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { usePlannerPresence } from '../hooks/usePlannerPresence';

const HEARTBEAT_URL = '/api/task-planner/heartbeat';

/** Parse the JSON body of the Nth apiFetch call. */
function bodyOfCall(mock: ReturnType<typeof vi.fn>, index: number): any {
  const [, options] = mock.mock.calls[index];
  return JSON.parse((options as RequestInit).body as string);
}

/** Return only the heartbeat POST calls. */
function heartbeatCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter((c) => c[0] === HEARTBEAT_URL);
}

describe('usePlannerPresence', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockResolvedValue({ ok: true, status: 202, json: () => Promise.resolve({ ok: true }) } as any);
    vi.mocked(AppContext.useApp).mockReturnValue({ currentTabId: 1 } as any);
    // Ensure visible by default
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an active heartbeat immediately on mount', () => {
    renderHook(() => usePlannerPresence());

    const calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0][0]).toBe(HEARTBEAT_URL);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ tabId: 1, active: true });
  });

  it('sends an inactive heartbeat after 5+ minutes of no activity', () => {
    renderHook(() => usePlannerPresence());
    apiFetchMock.mockClear();

    act(() => {
      // Advance past 5 minutes with no user events
      vi.advanceTimersByTime(5 * 60 * 1000 + 61 * 1000);
    });

    const calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ tabId: 1, active: false });
  });

  it('sends inactive on visibilitychange to hidden before the 5-minute mark', () => {
    renderHook(() => usePlannerPresence());
    apiFetchMock.mockClear();

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      // Let the interval tick evaluate the hidden state
      vi.advanceTimersByTime(31 * 1000);
    });

    const calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body.active).toBe(false);
  });

  it('sends active again after activity resumes following an inactive transition', () => {
    renderHook(() => usePlannerPresence());
    apiFetchMock.mockClear();

    // Go inactive first
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 61 * 1000);
    });
    let calls = heartbeatCalls(apiFetchMock);
    expect(calls[calls.length - 1] && JSON.parse((calls[calls.length - 1][1] as RequestInit).body as string).active).toBe(false);
    apiFetchMock.mockClear();

    // Now the user moves the mouse — should transition back to active
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove'));
      vi.advanceTimersByTime(31 * 1000);
    });

    calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body.active).toBe(true);
  });

  it('re-warms the real tab once currentTabId resolves from null', () => {
    // Simulate AppContext's async tab load: currentTabId starts null, then
    // becomes a real id after GET /api/tabs resolves.
    vi.mocked(AppContext.useApp).mockReturnValue({ currentTabId: null } as any);

    const { rerender } = renderHook(() => usePlannerPresence());

    // Mount fired an active heartbeat, but with no tab yet (tabId undefined).
    let calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(1);
    expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({
      active: true,
    });
    apiFetchMock.mockClear();

    // Tabs finish loading — currentTabId becomes a real id.
    act(() => {
      vi.mocked(AppContext.useApp).mockReturnValue({ currentTabId: 7 } as any);
      rerender();
    });

    // An active heartbeat for the real tab must be sent even though the
    // active/inactive state itself never transitioned.
    calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(1);
    expect(JSON.parse((calls[0][1] as RequestInit).body as string)).toEqual({
      tabId: 7,
      active: true,
    });
  });

  it('does not fire duplicate heartbeats while continuously active', () => {
    renderHook(() => usePlannerPresence());
    apiFetchMock.mockClear();

    act(() => {
      // Repeated activity while already active — no transition, no new heartbeat
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new MouseEvent('mousemove'));
        vi.advanceTimersByTime(31 * 1000);
      }
    });

    const calls = heartbeatCalls(apiFetchMock);
    expect(calls.length).toBe(0);
  });
});
