import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProvider, useApp } from '../context/AppContext';
import { useRouteSync } from '../hooks/useRouteSync';
import { useEffect } from 'react';

// Mock fetch for auth and data loading
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01' } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  }));
  vi.stubGlobal('WebSocket', class MockWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  });
});

/**
 * Helper: a component that uses useRouteSync and exposes its state for assertions.
 */
let capturedState: { activeSessionId: number | null; activeAgentId: number | null; activeView: string } | null = null;

function RouteSyncTestComponent() {
  useRouteSync();
  const { activeSessionId, activeAgentId, activeView } = useApp();
  useEffect(() => {
    capturedState = { activeSessionId, activeAgentId, activeView };
  });
  return <div data-testid="route-sync-test">{activeView}-{activeSessionId}-{activeAgentId}</div>;
}

function renderWithRouterAtPath(path: string) {
  const router = createMemoryRouter(
    [{ path: '*', element: <RouteSyncTestComponent /> }],
    { initialEntries: [path] }
  );
  return render(
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  );
}

describe('useRouteSync', () => {
  it('sets activeSessionId when on /sessions/:id', async () => {
    await act(async () => {
      renderWithRouterAtPath('/sessions/42');
    });
    expect(capturedState!.activeView).toBe('sessions');
    expect(capturedState!.activeSessionId).toBe(42);
  });

  it('clears activeSessionId when on /sessions (no id)', async () => {
    await act(async () => {
      renderWithRouterAtPath('/sessions');
    });
    expect(capturedState!.activeView).toBe('sessions');
    expect(capturedState!.activeSessionId).toBeNull();
  });

  it('sets activeAgentId when on /agents/:id', async () => {
    await act(async () => {
      renderWithRouterAtPath('/agents/7');
    });
    expect(capturedState!.activeView).toBe('agents');
    expect(capturedState!.activeAgentId).toBe(7);
  });

  it('clears activeAgentId when on /agents (no id)', async () => {
    await act(async () => {
      renderWithRouterAtPath('/agents');
    });
    expect(capturedState!.activeView).toBe('agents');
    expect(capturedState!.activeAgentId).toBeNull();
  });

  it('clears both IDs when navigating to /tasks', async () => {
    await act(async () => {
      renderWithRouterAtPath('/tasks');
    });
    expect(capturedState!.activeView).toBe('boards');
    expect(capturedState!.activeSessionId).toBeNull();
    expect(capturedState!.activeAgentId).toBeNull();
  });

  it('clears both IDs when navigating to /errors', async () => {
    await act(async () => {
      renderWithRouterAtPath('/errors');
    });
    expect(capturedState!.activeView).toBe('errors');
    expect(capturedState!.activeSessionId).toBeNull();
    expect(capturedState!.activeAgentId).toBeNull();
  });

  it('clears both IDs when navigating to /usage', async () => {
    await act(async () => {
      renderWithRouterAtPath('/usage');
    });
    expect(capturedState!.activeView).toBe('usage');
    expect(capturedState!.activeSessionId).toBeNull();
    expect(capturedState!.activeAgentId).toBeNull();
  });
});
