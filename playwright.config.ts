import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

/**
 * UI tests (Playwright). `npm run build` first, then `npm run test:ui`.
 * The global setup starts one demo server (SM_DEMO=1, fresh temp data dir) on a free port.
 * See docs/TESTING.md.
 */

// Choose the port once in the main process; workers inherit the environment variable.
if (!process.env.SM_E2E_PORT) {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  process.env.SM_E2E_PORT = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
}
const baseURL = `http://127.0.0.1:${process.env.SM_E2E_PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  workers: process.env.SM_E2E_WORKERS ? Number(process.env.SM_E2E_WORKERS) : CI ? 2 : 4,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // the production build registers a service worker; keep every test on the network
    serviceWorkers: 'block',
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'desktop',
      grepInvert: /@mobile/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      grep: /@mobile/,
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
