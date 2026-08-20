import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Route component for /login — redirects to the static login.html page.
 * Preserves the original intended URL as a query parameter so that after login,
 * the user can be redirected back to their deep-link destination.
 */
export function LoginRedirect() {
  const location = useLocation();

  useEffect(() => {
    const returnTo = location.state?.returnTo || '/';
    const params = returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    window.location.href = `/login.html${params}`;
  }, [location.state]);

  return null;
}
