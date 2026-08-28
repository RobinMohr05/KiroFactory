import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { createTestRouter } from '../router';

// Mock fetch for auth check and data loading
function mockAuthenticatedFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01', uiViewMode: 'advanced' } }),
      });
    }
    if (url === '/api/tabs') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/sessions') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/errors') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === '/api/usage/current-month') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalCostEur: 0 }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }));
}

function mockUnauthenticatedFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }));
}

function renderWithRouter(initialEntries: string[]) {
  const testRouter = createTestRouter(initialEntries);
  return render(
    <AppProvider>
      <RouterProvider router={testRouter} />
    </AppProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', class MockWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  });
});

describe('Routing', () => {
  describe('route-to-view mapping', () => {
    beforeEach(() => {
      mockAuthenticatedFetch();
    });

    // Note: React Router's <Navigate replace /> calls window.history.replaceState which
    // jsdom does not support ("Not implemented: navigation (except hash changes)"). These
    // redirect tests therefore cannot be verified in the jsdom test environment. The redirect
    // behavior is verified via Puppeteer integration tests against the running app instead.
    it.skip('/ redirects to /tasks', async () => {
      await act(async () => {
        renderWithRouter(['/']);
      });
      await waitFor(() => {
        expect(screen.getByText('To Do')).toBeInTheDocument();
      }, { timeout: 5000 });
    });

    it('/tasks renders the TasksPanel', async () => {
      await act(async () => {
        renderWithRouter(['/tasks']);
      });
      expect(screen.getByText('To Do')).toBeInTheDocument();
    });

    it('/sessions renders the SessionsPanel', async () => {
      await act(async () => {
        renderWithRouter(['/sessions']);
      });
      expect(screen.getByText('+ New Session')).toBeInTheDocument();
    });

    it('/sessions/:id renders the SessionsPanel with that session selected', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01', uiViewMode: 'advanced' } }),
          });
        }
        if (url === '/api/sessions') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ id: 123, name: 'Test Session', status: 'stopped', tabIds: [] }]),
          });
        }
        if (url === '/api/tabs') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }
        if (url === '/api/agents') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }
        if (url === '/api/errors') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }
        if (url === '/api/usage/current-month') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalCostEur: 0 }) });
        }
        if (url.includes('/api/sessions/123/output')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }));

      await act(async () => {
        renderWithRouter(['/sessions/123']);
      });
      // The sessions panel should be showing
      expect(screen.getByText('+ New Session')).toBeInTheDocument();
    });

    it('/agents renders the AgentsPanel', async () => {
      await act(async () => {
        renderWithRouter(['/agents']);
      });
      expect(screen.getByRole('tabpanel', { name: /agents/i })).toBeInTheDocument();
    });

    it('/agents/:id renders the AgentsPanel with that agent selected', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01', uiViewMode: 'advanced' } }),
          });
        }
        if (url === '/api/agents') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ id: 5, name: 'Test Agent', prompt: 'hello', tools: [], allowedTools: [], resources: [] }]),
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
        if (url === '/api/usage/current-month') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalCostEur: 0 }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }));

      await act(async () => {
        renderWithRouter(['/agents/5']);
      });
      await waitFor(() => {
        expect(screen.getByRole('tabpanel', { name: /agents/i })).toBeInTheDocument();
      });
    });

    it('/errors renders the ErrorsPanel', async () => {
      await act(async () => {
        renderWithRouter(['/errors']);
      });
      expect(screen.getByRole('tabpanel', { name: /logs/i })).toBeInTheDocument();
    });

    it('/usage renders the UsagePanel', async () => {
      await act(async () => {
        renderWithRouter(['/usage']);
      });
      expect(screen.getByRole('tabpanel', { name: /usage/i })).toBeInTheDocument();
    });

    it('looper mode renders the full Advanced-style layout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/me') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: { id: 1, email: 'test@test.com', createdAt: '2024-01-01', uiViewMode: 'looper' } }),
          });
        }
        if (url === '/api/tabs') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        if (url === '/api/sessions') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        if (url === '/api/agents') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        if (url === '/api/errors') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        if (url === '/api/flocks') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        if (url === '/api/usage/current-month') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ totalCostEur: 0 }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }));

      await act(async () => {
        renderWithRouter(['/tasks']);
      });
      expect(screen.getByText('To Do')).toBeInTheDocument();
    });
  });

  describe('auth guard', () => {
    it('does not render protected content when unauthenticated', async () => {
      mockUnauthenticatedFetch();

      await act(async () => {
        renderWithRouter(['/tasks']);
      });

      // The auth check in AppContext redirects to login.html via window.location.href
      // The AppLayout returns null while user is null (before auth resolves or on 401)
      // So protected content should not be visible
      expect(screen.queryByText('To Do')).not.toBeInTheDocument();
    });
  });

  describe('ViewTabs navigation uses router', () => {
    beforeEach(() => {
      mockAuthenticatedFetch();
    });

    it('active tab reflects the current route', async () => {
      await act(async () => {
        renderWithRouter(['/sessions']);
      });
      const sessionsTab = screen.getByRole('tab', { name: /sessions/i });
      expect(sessionsTab.classList.contains('active')).toBe(true);
    });
  });

  describe('wildcard catch-all route', () => {
    beforeEach(() => {
      mockAuthenticatedFetch();
    });

    // See comment on "/ redirects to /tasks" — jsdom does not support React Router's
    // <Navigate replace /> navigation. These are verified via Puppeteer instead.
    it.skip('unknown paths redirect to /tasks', async () => {
      await act(async () => {
        renderWithRouter(['/nonexistent']);
      });
      expect(await screen.findByText('To Do')).toBeInTheDocument();
    });

    it.skip('/foobar redirects to /tasks', async () => {
      await act(async () => {
        renderWithRouter(['/foobar']);
      });
      expect(await screen.findByText('To Do')).toBeInTheDocument();
    });
  });

  describe('auth deep-link preservation', () => {
    it('redirects to login.html with returnTo param when unauthenticated on a deep link', async () => {
      mockUnauthenticatedFetch();
      const hrefSetter = vi.fn();
      // Mock window.location.href as a settable property
      Object.defineProperty(window, 'location', {
        value: { ...window.location, pathname: '/sessions/5', search: '', href: '' },
        writable: true,
      });
      Object.defineProperty(window.location, 'href', {
        set: hrefSetter,
        get: () => '',
      });

      await act(async () => {
        renderWithRouter(['/sessions/5']);
      });

      // Wait for async auth check to complete
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // Should redirect with returnTo parameter
      const lastCall = hrefSetter.mock.calls[hrefSetter.mock.calls.length - 1]?.[0] || '';
      expect(lastCall).toContain('login.html');
      expect(lastCall).toContain('returnTo');
      expect(lastCall).toContain(encodeURIComponent('/sessions/5'));
    });
  });
});
