/// <reference types="vitest/globals" />
import '@testing-library/jest-dom';

// jsdom does not implement window.matchMedia; provide a minimal stub
// so components that use matchMedia (e.g. MobileDrawer auto-close) don't crash.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
