import { Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Header } from './Header';
import { TabBar } from './TabBar';
import { ViewTabs } from './ViewTabs';
import { MobileTabSelector } from './MobileTabSelector';
import { EasySessionsView } from './EasySessionsView';
import { useRouteSync } from '../hooks/useRouteSync';
import { usePlannerPresence } from '../hooks/usePlannerPresence';

export function AppLayout() {
  const { user } = useApp();

  // Sync the current route to AppContext's activeView / activeSessionId / activeAgentId
  useRouteSync();

  // Presence-driven prewarm/drain of the AI Task Planner pool. Mounted here so
  // it runs globally for any authenticated view, not scoped to a single panel.
  usePlannerPresence();

  // Auth guard: redirect to /login if not authenticated
  if (user === null) {
    // user is null when auth check hasn't completed yet OR when 401 was returned.
    // The AppContext auth check redirects to login.html directly on 401,
    // but if the user navigates directly to a protected route before the check completes,
    // we let the page render empty (no flash) until the auth state resolves.
    // The redirect to /login is handled by AppContext's auth check effect.
    return null;
  }

  // Easy mode: only the Header (login/out, settings, theme toggle, usage
  // badge) is shared with Advanced mode. Everything below it — tabs,
  // ViewTabs, and the routed panels — is replaced by the simplified
  // sessions-only view. Defaults to 'easy' while `user` is still loading
  // (matches the backend default for new accounts) so there's no
  // Advanced-UI flash before the profile fetch resolves.
  const isEasyMode = (user?.uiViewMode ?? 'easy') === 'easy';

  if (isEasyMode) {
    return (
      <>
        <Header />
        <EasySessionsView />
      </>
    );
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
