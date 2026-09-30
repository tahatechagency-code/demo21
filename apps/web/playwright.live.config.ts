import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e against the DEPLOYED site (real Vercel frontend -> real API -> real Gemini): no local
 * servers, no database access. Run with
 *   LIVE_URL=https://demo21-blond.vercel.app PW_CHROMIUM_PATH=<chrome.exe> pnpm --filter @ai-concierge/web test:e2e:live
 */
export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 150_000,
  expect: { timeout: 90_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.LIVE_URL ?? 'https://demo21-blond.vercel.app',
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'live-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }],
});
