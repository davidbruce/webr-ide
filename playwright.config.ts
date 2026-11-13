// End-to-end tests in WebKit (Safari's engine, the main target).
//
//   npm test             everything except the PWA tests
//   npm run test:pwa     offline start + update prompt, against a production build
//
// Tests tagged @network install packages from repo.r-wasm.org; skip them
// with `npm test -- --grep-invert @network`.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5299;

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: /pwa\.spec\.ts/,
  // R starts in every test file's fresh browser storage; installs can be slow.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // WebKit shares site storage between profiles, so tests can't overlap.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    ...devices['Desktop Safari'],
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
