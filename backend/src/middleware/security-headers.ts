import type { Express } from "express";
import helmet from "helmet";

/**
 * Registers security-response-header middleware (helmet) and disables the
 * Express `X-Powered-By` header.
 *
 * OWASP A05 — Security Misconfiguration; coding_guidelines.MD §2 explicitly
 * requires "helmet middleware for security headers" and "Remove X-Powered-By
 * header" (rated HIGH).
 *
 * The backend serves the SPA (frontend/dist) on the same origin, so these
 * headers protect the served HTML/JS against clickjacking (X-Frame-Options,
 * frame-ancestors), MIME sniffing (X-Content-Type-Options), and
 * mixed-content downgrade (HSTS).
 *
 * Content-Security-Policy is tuned to allow the SPA's own assets — the app
 * ships an inline theme-bootstrap script and inline styles in index.html
 * (and the legacy login/impressum pages), pulls fonts from Google Fonts, and
 * opens WebSocket connections (/ws) back to the same origin — so a strict
 * default-only policy would break it.
 *
 * Call this EARLY in the middleware chain (before route handlers and static
 * file serving) so every response — including the served SPA HTML — carries
 * the headers.
 */
export function applySecurityHeaders(app: Express): void {
  // Express default advertises the framework via `X-Powered-By: Express`.
  // Remove it to avoid leaking implementation details to attackers.
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Inline theme-bootstrap <script> in index.html requires 'unsafe-inline'.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          // Inline styles (React + static pages) and Google Fonts CSS.
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          // Google Fonts font files.
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          // SVG favicon and data: URIs.
          imgSrc: ["'self'", "data:"],
          // Same-origin API fetches plus WebSocket connections (/ws).
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
    }),
  );
}
