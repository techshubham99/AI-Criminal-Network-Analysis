/**
 * Live-backend integration tests.
 *
 * These are NOT part of `npm test`. They hit a real, running FastAPI backend and
 * assert that the response shapes the frontend's type layer claims are actually
 * what the backend sends — the one test category that can catch contract drift.
 *
 *   1. start the backend (see frontend/README.md)
 *   2. npm run test:live
 *
 * Every test in this suite skips itself (rather than failing) when the backend
 * is unreachable, so a developer without a backend running is not blocked.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/test/live/**/*.{test,spec}.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
