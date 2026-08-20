import { useEffect } from 'react';

/**
 * Route component for /login — redirects to the static login.html page.
 * This serves as the auth guard redirect target within the React Router tree.
 */
export function LoginRedirect() {
  useEffect(() => {
    window.location.href = '/login.html';
  }, []);

  return null;
}
