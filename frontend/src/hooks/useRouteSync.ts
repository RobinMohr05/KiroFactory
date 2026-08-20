import { useEffect } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import type { ViewTab } from '../types';

/**
 * Syncs the current route to the AppContext state (activeView, activeSessionId, activeAgentId).
 * This hook should be called in AppLayout (inside the router context).
 */
export function useRouteSync() {
  const location = useLocation();
  const { setActiveView, setActiveSessionId, setActiveAgentId } = useApp();

  useEffect(() => {
    const path = location.pathname;

    if (path.startsWith('/sessions')) {
      setActiveView('sessions');
      const match = path.match(/^\/sessions\/(\d+)/);
      if (match) {
        setActiveSessionId(Number(match[1]));
      }
    } else if (path.startsWith('/agents')) {
      setActiveView('agents');
      const match = path.match(/^\/agents\/(\d+)/);
      if (match) {
        setActiveAgentId(Number(match[1]));
      }
    } else if (path.startsWith('/errors')) {
      setActiveView('errors');
    } else if (path.startsWith('/usage')) {
      setActiveView('usage');
    } else {
      // /tasks or anything else
      setActiveView('boards');
    }
  }, [location.pathname, setActiveView, setActiveSessionId, setActiveAgentId]);
}
