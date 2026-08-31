/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * publicDir is disabled below (public/ is served directly by the backend's
 * Express static middleware, not copied into dist/ — see backend/src/index.ts).
 * That means the static, non-Vite-processed pages in public/ (login.html,
 * impressum.html) can't `import` src/style.css the way main.tsx does; they
 * link it as a plain <link rel="stylesheet" href="style.css">. This plugin
 * keeps a real copy of style.css in public/ in sync with the single source
 * of truth in src/, on both `vite` (dev) and `vite build`, so that link
 * resolves to actual CSS instead of falling through to the catch-all route.
 */
function syncPublicStylesheet(): Plugin {
  const sync = () => {
    copyFileSync(resolve(__dirname, 'src/style.css'), resolve(__dirname, 'public/style.css'))
  }
  return {
    name: 'sync-public-stylesheet',
    buildStart: sync,
    configureServer(server) {
      sync()
      server.watcher.add(resolve(__dirname, 'src/style.css'))
      server.watcher.on('change', (file) => {
        if (file === resolve(__dirname, 'src/style.css')) sync()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), syncPublicStylesheet()],
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3500',
      '/ws': {
        target: 'ws://localhost:3500',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
