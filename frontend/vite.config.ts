/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The frontend never talks to anything but the local FastAPI backend.
 *
 * By default `VITE_API_BASE_URL` is unset, so the API layer issues *relative*
 * requests (`/api/v1/...`) and this dev-server proxy forwards them to the
 * backend. That keeps the browser same-origin (no CORS reliance) and means the
 * backend needs no change whatsoever. Point the proxy elsewhere with
 * `VITE_API_PROXY_TARGET` (see .env.example).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
    preview: {
      port: 4173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['src/test/live/**', 'node_modules/**', 'dist/**'],
      restoreMocks: true,
    },
  };
});
