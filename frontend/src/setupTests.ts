/// <reference types="vitest/globals" />
import '@testing-library/jest-dom';

// Pin the timezone for the whole test run so date-formatting assertions are
// deterministic regardless of the host's local zone. formatConversationDate()
// in TaskPlannerModal renders in local time (d.getHours(), d.getDate(), etc.),
// so a UTC fixture like 2026-09-21T20:10:00Z would roll forward to Sep 22 in
// any zone at/beyond ~UTC+3:50 (e.g. Asia/Kolkata, Asia/Tokyo), breaking the
// "Sep 21" date-fragment filter test. Forcing UTC keeps the formatted output
// identical everywhere (CI, local, off-UTC laptops).
process.env.TZ = 'UTC';

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
