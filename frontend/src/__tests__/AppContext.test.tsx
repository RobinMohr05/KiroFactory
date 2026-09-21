import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppProvider, useApp } from '../context/AppContext';
import { useEffect } from 'react';

// Track which URLs are fetched
let fetchedUrls: string[] = [];

// Minimal Tab shape
const makeTab = (id: number) => ({ id, name: `Tab ${id}`, repositoryUrl: '', createdAt: '', updatedAt: '' });

function setupFetch(tabs: ReturnType<typeof makeTab>[] = []) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    fetchedUrls.push(url);
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01' } }),
      });
    }
    if (url === '/api/tabs') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tabs) });
    }
    if (url === '/api/sessions') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ id: 1, name: 'test-agent', prompt: 'test' }]) });
    }
    if (url === '/api/errors') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }));
}

beforeEach(() => {
  fetchedUrls = [];
  localStorage.clear();
  setupFetch();

  vi.stubGlobal('WebSocket', class MockWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  });
});

afterEach(() => {
  localStorage.clear();
});

// Helper component that exposes context values
function AgentsReader({ onAgents }: { onAgents: (agents: unknown[]) => void }) {
  const { agents } = useApp();
  useEffect(() => {
    onAgents(agents);
  }, [agents, onAgents]);
  return null;
}

function ContextReader({ onValue }: { onValue: (ctx: ReturnType<typeof useApp>) => void }) {
  const ctx = useApp();
  useEffect(() => {
    onValue(ctx);
  });
  return null;
}

describe('AppContext initialization', () => {
  it('fetches agents on app initialization (not just when AgentsPanel mounts)', async () => {
    render(
      <AppProvider>
        <div>test</div>
      </AppProvider>
    );

    await waitFor(() => {
      expect(fetchedUrls).toContain('/api/agents');
    });
  });

  it('populates agents state from initial fetch', async () => {
    let latestAgents: unknown[] = [];
    const onAgents = vi.fn((agents: unknown[]) => { latestAgents = agents; });

    render(
      <AppProvider>
        <AgentsReader onAgents={onAgents} />
      </AppProvider>
    );

    await waitFor(() => {
      expect(latestAgents.length).toBeGreaterThan(0);
    });
    expect(latestAgents[0]).toEqual(expect.objectContaining({ id: 1, name: 'test-agent' }));
  });
});

describe('AppContext localStorage persistence', () => {
  describe('currentTabId persistence', () => {
    it('writes currentTabId to localStorage when setCurrentTabId is called', async () => {
      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      act(() => {
        capturedCtx!.setCurrentTabId(42);
      });

      expect(localStorage.getItem('kf_currentTabId')).toBe('42');
    });

    it('removes kf_currentTabId from localStorage when setCurrentTabId(null) is called', async () => {
      localStorage.setItem('kf_currentTabId', '99');
      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      act(() => {
        capturedCtx!.setCurrentTabId(null);
      });

      expect(localStorage.getItem('kf_currentTabId')).toBeNull();
    });

    it('initializes currentTabId from localStorage on mount', async () => {
      localStorage.setItem('kf_currentTabId', '7');
      setupFetch([makeTab(7), makeTab(8)]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx?.currentTabId).toBe(7);
      });
    });

    it('falls back to null when localStorage has non-numeric currentTabId', async () => {
      localStorage.setItem('kf_currentTabId', 'not-a-number');
      setupFetch([]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      // Without tabs, currentTabId should remain null
      await waitFor(() => {
        expect(fetchedUrls).toContain('/api/tabs');
        expect(capturedCtx).not.toBeNull();
        expect(capturedCtx!.currentTabId).toBeNull();
      });
    });
  });

  describe('activeView persistence', () => {
    it('writes activeView to localStorage when setActiveView is called', async () => {
      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      act(() => {
        capturedCtx!.setActiveView('sessions');
      });

      expect(localStorage.getItem('kf_activeView')).toBe('sessions');
    });

    it('initializes activeView from localStorage when value is valid', async () => {
      localStorage.setItem('kf_activeView', 'agents');

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      expect(capturedCtx!.activeView).toBe('agents');
    });

    it('falls back to "boards" when localStorage has invalid activeView', async () => {
      localStorage.setItem('kf_activeView', 'invalid-view');

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      expect(capturedCtx!.activeView).toBe('boards');
    });

    it('falls back to "boards" when kf_activeView is absent', async () => {
      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      expect(capturedCtx!.activeView).toBe('boards');
    });
  });

  describe('fetchTabs validates persisted currentTabId', () => {
    it('keeps persisted tab ID if it exists in fetched tabs', async () => {
      localStorage.setItem('kf_currentTabId', '5');
      setupFetch([makeTab(5), makeTab(6)]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx?.currentTabId).toBe(5);
      });
    });

    it('falls back to first tab if persisted tab ID is not in fetched tabs', async () => {
      localStorage.setItem('kf_currentTabId', '999');
      setupFetch([makeTab(10), makeTab(11)]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx?.currentTabId).toBe(10);
      });
    });

    it('falls back to null if persisted tab ID is not in fetched tabs and no tabs available', async () => {
      localStorage.setItem('kf_currentTabId', '999');
      setupFetch([]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(fetchedUrls).toContain('/api/tabs');
        expect(capturedCtx).not.toBeNull();
        expect(capturedCtx!.currentTabId).toBeNull();
      });
    });

    it('uses first tab if no persisted ID and tabs are available', async () => {
      setupFetch([makeTab(3), makeTab(4)]);

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx?.currentTabId).toBe(3);
      });
    });
  });

  describe('logout clears localStorage keys', () => {
    it('removes kf_currentTabId and kf_activeView on logout', async () => {
      localStorage.setItem('kf_currentTabId', '5');
      localStorage.setItem('kf_activeView', 'sessions');

      // Stub window.location.href assignment
      const originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        value: { href: '' },
        writable: true,
      });

      let capturedCtx: ReturnType<typeof useApp> | null = null;
      render(
        <AppProvider>
          <ContextReader onValue={(ctx) => { capturedCtx = ctx; }} />
        </AppProvider>
      );

      await waitFor(() => {
        expect(capturedCtx).not.toBeNull();
      });

      await act(async () => {
        await capturedCtx!.logout();
      });

      expect(localStorage.getItem('kf_currentTabId')).toBeNull();
      expect(localStorage.getItem('kf_activeView')).toBeNull();

      // Restore
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });
  });
});
