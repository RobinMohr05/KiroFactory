import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { TasksPanel } from './components/TasksPanel';
import { SessionsPanel } from './components/SessionsPanel';
import { AgentsPanel } from './components/AgentsPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import { UsagePanel } from './components/UsagePanel';
import { LoginRedirect } from './components/LoginRedirect';

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: <LoginRedirect />,
  },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: 'tasks', element: <TasksPanel /> },
      { path: 'sessions', element: <SessionsPanel /> },
      { path: 'sessions/:id', element: <SessionsPanel /> },
      { path: 'agents', element: <AgentsPanel /> },
      { path: 'agents/:id', element: <AgentsPanel /> },
      { path: 'errors', element: <ErrorsPanel /> },
      { path: 'usage', element: <UsagePanel /> },
      { path: '*', element: <Navigate to="/tasks" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);

/**
 * Create a memory router for testing purposes.
 */
export function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(routes, { initialEntries });
}
