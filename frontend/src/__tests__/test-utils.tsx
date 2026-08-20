import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Wraps a component tree with a MemoryRouter for tests.
 * Use this when testing components that use useNavigate/useLocation/useParams.
 */
export function TestRouter({ children, initialEntries = ['/'] }: { children: ReactNode; initialEntries?: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      {children}
    </MemoryRouter>
  );
}
