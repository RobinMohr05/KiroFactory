import { useCallback } from 'react';

function getPreferredTheme(): string {
  const stored = localStorage.getItem('vibecode-heaven-theme');
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vibecode-heaven-theme', theme);
}

export function useTheme() {
  const toggleTheme = useCallback(() => {
    const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }, []);

  return { toggleTheme };
}
