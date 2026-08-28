import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { act } from 'react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { TaskPlannerModal } from '../components/TaskPlannerModal';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    currentTabId: 1,
    setTasks: vi.fn(),
    sessions: [],
    setSessions: vi.fn(),
    tabs: [{ id: 1, name: 'Test Tab' }],
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('TaskPlannerModal - session leak prevention', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
  });

  afterEach(() => {
    cleanup();
  });

  it('cleans up orphaned session when effect is re-run (StrictMode double-invoke)', async () => {
    // Simulate two sessions being created by sequential mounts (StrictMode behavior)
    // First call returns session 100, second call returns session 200
    let callCount = 0;
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        callCount++;
        const sessionId = callCount === 1 ? 100 : 200;
        return {
          ok: true,
          json: async () => ({ sessionId }),
        };
      }
      // DELETE calls for cleanup
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    // Simulate StrictMode: mount -> unmount -> mount
    // First mount
    const { unmount: unmount1 } = render(<TaskPlannerModal onClose={vi.fn()} />);

    // Let the first session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Unmount (StrictMode cleanup) — this should trigger cleanup of session 100
    unmount1();

    // Allow async cleanup to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // The orphaned session (100) should be cleaned up via DELETE
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/100');
  });

  it('cleans up the orphaned session when unmount happens BEFORE /start resolves (true StrictMode timing)', async () => {
    // React StrictMode's mount->cleanup->remount cycle runs the cleanup
    // synchronously, immediately after mount — well before any in-flight
    // network request has a chance to resolve. Use a manually-controlled
    // deferred promise so we can unmount while /start is still pending,
    // then resolve it afterward, to reproduce that exact ordering.
    let resolveStart: ((value: { ok: boolean; json: () => Promise<{ sessionId: number }> }) => void) | null = null;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<{ sessionId: number }> }>((resolve) => {
      resolveStart = resolve;
    });

    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return startPromise;
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} />);

    // Unmount immediately — /start is still pending, so at this point
    // createdSessionId is still null inside the effect closure.
    unmount();

    // Now let /start resolve, AFTER cleanup has already run.
    await act(async () => {
      resolveStart!({ ok: true, json: async () => ({ sessionId: 100 }) });
      await new Promise(r => setTimeout(r, 10));
    });

    // The session created by the now-cancelled effect must still be deleted —
    // not silently abandoned/leaked as a live backend session + kiro-cli process.
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/100');
  });

  it('cleans up session on unmount even if fetch already resolved', async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 42 }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    mockUseApp({ currentTabId: 1 });

    const { unmount } = render(<TaskPlannerModal onClose={vi.fn()} />);

    // Let the session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Unmount the component (user closes modal quickly, or StrictMode cleanup)
    unmount();

    // Allow async cleanup to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Session 42 should be cleaned up via DELETE on unmount
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url.includes('/api/task-planner/') && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe('/api/task-planner/42');
  });

  it('does not double-delete when handleClose is used normally', async () => {
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 55 }),
        };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const onClose = vi.fn();
    mockUseApp({ currentTabId: 1 });

    const { getByText, unmount } = render(<TaskPlannerModal onClose={onClose} />);

    // Let the session start resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // User clicks Cancel button — this triggers handleClose which calls DELETE
    const cancelBtn = getByText('Cancel');
    await act(async () => {
      cancelBtn.click();
    });

    // Allow the async DELETE from handleClose to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Now unmount (triggered by onClose hiding the modal)
    unmount();

    // Allow any async cleanup from the effect to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    // Session 55 should only be deleted ONCE (not double-deleted)
    const deleteCalls = apiFetchMock.mock.calls.filter(
      ([url, opts]) => typeof url === 'string' && url === '/api/task-planner/55' && opts?.method === 'DELETE'
    );
    expect(deleteCalls.length).toBe(1);
  });
});

describe('TaskPlannerModal - modal CSS class structure', () => {
  let apiFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock = vi.mocked(api.apiFetch);
    apiFetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === '/api/task-planner/start' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ sessionId: 1 }) };
      }
      if (opts?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mockUseApp({ currentTabId: 1 });
  });

  afterEach(() => {
    cleanup();
  });

  it('backdrop div has only "modal-backdrop" class, not "task-planner-modal"', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).toBeTruthy();
    expect(backdrop!.className).toBe('modal-backdrop');
  });

  it('dialog div has "modal", "modal-wide", and "task-planner-modal" classes', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.classList.contains('modal')).toBe(true);
    expect(dialog!.classList.contains('modal-wide')).toBe(true);
    expect(dialog!.classList.contains('task-planner-modal')).toBe(true);
  });

  it('does not use "task-planner-content" class anywhere', () => {
    const { container } = render(<TaskPlannerModal onClose={vi.fn()} />);
    expect(container.querySelector('.task-planner-content')).toBeNull();
  });
});
