/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3500',
      '/ws': {
        target: 'ws://localhost:3500',
        ws: true,
        // Backend (tsx watch) starts concurrently with Vite and needs a moment
        // to bind port 3500. Swallow the resulting ECONNABORTED/ECONNREFUSED
        // on the proxy socket during that window instead of logging it as an
        // unhandled proxy error; the client's own WS reconnect logic retries.
        configure: (proxy) => {
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNABORTED' || err.code === 'ECONNREFUSED') {
              return;
            }
            console.error('[vite] ws proxy error:', err);
          });
        },
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
