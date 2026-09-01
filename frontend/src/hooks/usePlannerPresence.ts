import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

/** How long without activity before we consider the user inactive. */
const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
/** How often the presence check runs. */
const CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
/** Throttle window for activity events — one "touch" of lastActivity per window. */
const ACTIVITY_THROTTLE_MS = 3 * 1000; // 3 seconds

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'keydown',
  'click',
  'scroll',
];

/**
 * Presence-driven prewarm/drain of the AI Task Planner pool.
 *
 * While the user is active on the board page, we periodically tell the backend
 * to keep a warm KiroRunner ready for the current tab (so the "+ Task" AI
 * planner opens instantly). Once the user goes idle — no mouse/keyboard/scroll
 * activity for 5 minutes, or the browser tab is hidden — we tell the backend to
 * drain that warm process promptly rather than waiting for the slow idle reaper.
 *
 * Heartbeats are only sent on active/inactive *transitions*, not every tick, so
 * a continuously-active user produces just the initial mount heartbeat.
 */
export function usePlannerPresence(): void {
  const { currentTabId } = useApp();

  // Keep the latest tabId in a ref so the long-lived interval/listeners always
  // read the current value without re-subscribing on every tab change.
  const tabIdRef = useRef<number | null>(currentTabId);
  tabIdRef.current = currentTabId;

  const lastActivityRef = useRef<number>(Date.now());
  const lastThrottleRef = useRef<number>(0);
  // null = not yet reported; otherwise the last active-state we sent.
  const activeStateRef = useRef<boolean | null>(null);
  // The tabId of the most recent active heartbeat we sent, so we can detect
  // when the current tab changes out from under a still-active session.
  const warmedTabIdRef = useRef<number | null | undefined>(undefined);

  // Stable sender kept in a ref so both the lifetime effect and the
  // currentTabId-keyed effect below share one implementation.
  const sendHeartbeatRef = useRef<(active: boolean) => void>(() => {});
  sendHeartbeatRef.current = (active: boolean) => {
    const tabId = tabIdRef.current;
    if (active) warmedTabIdRef.current = tabId ?? null;
    apiFetch('/api/task-planner/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: tabId ?? undefined, active }),
    }).catch(() => {
      // Best-effort — presence signals never surface errors to the user.
    });
  };

  useEffect(() => {
    const sendHeartbeat = (active: boolean) => {
      sendHeartbeatRef.current(active);
    };

    /** Send a heartbeat only when the active-state actually changes. */
    const reportState = (active: boolean) => {
      if (activeStateRef.current === active) return;
      activeStateRef.current = active;
      sendHeartbeat(active);
    };

    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      // Throttle: only re-evaluate transitions at most once per throttle window.
      if (now - lastThrottleRef.current < ACTIVITY_THROTTLE_MS) return;
      lastThrottleRef.current = now;
      if (document.visibilityState !== 'hidden') {
        reportState(true);
      }
    };

    const evaluate = () => {
      const idle = Date.now() - lastActivityRef.current > INACTIVITY_MS;
      const hidden = document.visibilityState === 'hidden';
      reportState(!(idle || hidden));
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        reportState(false);
      } else {
        // Coming back into view counts as activity.
        lastActivityRef.current = Date.now();
        reportState(true);
      }
    };

    const onBeforeUnload = () => {
      // Best-effort courtesy drain on page unload.
      reportState(false);
    };

    // Immediate active heartbeat on mount so a fresh page load prewarms.
    reportState(true);

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, markActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    const interval = setInterval(evaluate, CHECK_INTERVAL_MS);

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, markActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearInterval(interval);
      // Final best-effort drain on unmount.
      sendHeartbeat(false);
    };
    // Intentionally empty deps: the hook subscribes once for the app lifetime
    // and reads currentTabId via tabIdRef to avoid re-subscribing on tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-warm the newly-current tab whenever currentTabId changes while the user
  // is active. This covers two cases the transition-only heartbeat misses:
  //   1. Fresh page load: AppContext initializes currentTabId to null and only
  //      resolves it asynchronously after GET /api/tabs. The mount heartbeat
  //      fires with tabId undefined (warms tab 0); once the real tab id lands,
  //      a continuously-active user produces no active/inactive transition, so
  //      without this the real tab would never be warmed.
  //   2. Switching boards: moving to another tab should warm that tab's pool.
  useEffect(() => {
    // Only re-warm while we're in the active state. If we've never reported, or
    // we're currently inactive, there's nothing warm to move to the new tab.
    if (activeStateRef.current !== true) return;
    // No-op if the tab we last warmed already matches the current one.
    if (warmedTabIdRef.current === (currentTabId ?? null)) return;
    sendHeartbeatRef.current(true);
  }, [currentTabId]);
}
