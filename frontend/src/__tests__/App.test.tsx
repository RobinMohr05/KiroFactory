import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { createTestRouter } from '../router';

// Mock fetch for auth check
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
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
    if (url === '/api/errors') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/usage/current-month') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalCostEur: 0 }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }));

  // Mock WebSocket
  vi.stubGlobal('WebSocket', class MockWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  });
});

function renderApp(initialEntries: string[] = ['/tasks']) {
  const testRouter = createTestRouter(initialEntries);
  return render(
    <AppProvider>
      <RouterProvider router={testRouter} />
    </AppProvider>
  );
}

describe('App', () => {
  it('renders the header with app name', async () => {
    await act(async () => { renderApp(); });
    expect(screen.getByText('code')).toBeInTheDocument();
  });

  it('renders the view tabs (Tasks, Sessions, Agents, Errors)', async () => {
    await act(async () => { renderApp(); });
    expect(screen.getByRole('tab', { name: /tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sessions/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /errors/i })).toBeInTheDocument();
  });

  it('renders the kanban columns', async () => {
    await act(async () => { renderApp(); });
    expect(screen.getByText('To Do')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Developed')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('renders the + Task button', async () => {
    await act(async () => { renderApp(); });
    expect(screen.getByText('+ Task')).toBeInTheDocument();
  });
});
