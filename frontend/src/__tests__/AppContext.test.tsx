import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AppProvider, useApp } from '../context/AppContext';
import { useEffect } from 'react';

// Track which URLs are fetched
let fetchedUrls: string[] = [];

beforeEach(() => {
  fetchedUrls = [];
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
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
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

  vi.stubGlobal('WebSocket', class MockWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  });
});

// Helper component that exposes context values
function AgentsReader({ onAgents }: { onAgents: (agents: unknown[]) => void }) {
  const { agents } = useApp();
  useEffect(() => {
    onAgents(agents);
  }, [agents, onAgents]);
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
