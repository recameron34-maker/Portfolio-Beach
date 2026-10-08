import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end tests (docs/12 section 3) run the real API over an in-process database seeded with
 * the small synthetic profile, and the web app through Vite with the API proxied.
 */
const scratch = process.env.PB_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'pb-e2e-'));
// Overridable so several checkouts (agent worktrees) can run the journeys side by side.
const apiPort = Number(process.env.PB_E2E_API_PORT ?? 3101);
const webPort = Number(process.env.PB_E2E_WEB_PORT ?? 5174);

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
  // Both servers bind IPv4 loopback explicitly: Playwright polls 127.0.0.1, and on hosts where
  // localhost resolves to ::1 first (GitHub runners) a server bound to "localhost" never answers.
  // In CI their stdout is kept so a start-up problem shows in the job log.
  webServer: [
    {
      command: `node scripts/e2e-api.mjs`,
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: process.env.CI ? 'pipe' : 'ignore',
      env: { PB_E2E_DIR: scratch, PORT: String(apiPort) },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: process.env.CI ? 'pipe' : 'ignore',
      env: { PB_API_URL: `http://127.0.0.1:${apiPort}` },
    },
  ],
  metadata: { scratch },
});
