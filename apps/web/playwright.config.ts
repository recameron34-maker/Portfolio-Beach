import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end tests (docs/12 section 3) run the real API over an in-process database seeded with
 * the small synthetic profile, and the web app through Vite with the API proxied.
 */
const scratch = process.env.PB_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'pb-e2e-'));
const apiPort = 3101;
const webPort = 5174;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node scripts/e2e-api.mjs`,
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PB_E2E_DIR: scratch, PORT: String(apiPort) },
    },
    {
      command: `pnpm exec vite --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PB_API_URL: `http://127.0.0.1:${apiPort}` },
    },
  ],
  metadata: { scratch },
});
