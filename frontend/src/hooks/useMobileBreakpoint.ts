import { useState, useEffect } from 'react';

const MOBILE_QUERY = '(max-width: 480px)';

/**
 * Returns true when viewport width is ≤480px (mobile breakpoint).
 * Listens for media query changes and re-renders on transition.
 */
export function useMobileBreakpoint(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = () => setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
