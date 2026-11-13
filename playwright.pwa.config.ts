// PWA tests (service worker, offline start, update prompt) need a production
// build: `npm run test:pwa` builds, serves it with `vite preview` and runs
// tests/e2e/pwa.spec.ts.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5298;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /pwa\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    ...devices['Desktop Safari'],
    viewport: { width: 1280, height: 860 },
  },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
