import { Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Header } from './Header';
import { TabBar } from './TabBar';
import { ViewTabs } from './ViewTabs';
import { MobileTabSelector } from './MobileTabSelector';
import { useRouteSync } from '../hooks/useRouteSync';

export function AppLayout() {
  const { user } = useApp();

  // Sync the current route to AppContext's activeView / activeSessionId / activeAgentId
  useRouteSync();

  // Auth guard: redirect to /login if not authenticated
  if (user === null) {
    // user is null when auth check hasn't completed yet OR when 401 was returned.
    // The AppContext auth check redirects to login.html directly on 401,
    // but if the user navigates directly to a protected route before the check completes,
    // we let the page render empty (no flash) until the auth state resolves.
    // The redirect to /login is handled by AppContext's auth check effect.
    return null;
  }

  return (
    <>
      <Header />
      <TabBar />
      <MobileTabSelector />
      <ViewTabs />
      <Outlet />
    </>
  );
}
