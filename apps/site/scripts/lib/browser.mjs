/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts and the check */
// Launches the Chromium the media scripts and the check drive. PW_CHROMIUM_PATH wins; otherwise
// Playwright's own browser; when that one is not installed, a preinstalled build under the
// browsers folder of a cloud sandbox is used.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const SANDBOX_BROWSERS = '/opt/pw-browsers';
const SANDBOX_CHROMIUM = join(SANDBOX_BROWSERS, 'chromium-1243', 'chrome-linux64', 'chrome');

/** The executable to launch, or undefined to let Playwright use its own. */
export function chromiumPath() {
  const override = process.env.PW_CHROMIUM_PATH;
  if (override !== undefined && override !== '') return override;
  let own;
  try {
    own = chromium.executablePath();
  } catch {
    own = '';
  }
  if (own !== '' && existsSync(own)) return undefined;
  if (existsSync(SANDBOX_CHROMIUM)) return SANDBOX_CHROMIUM;
  if (existsSync(SANDBOX_BROWSERS)) {
    for (const entry of readdirSync(SANDBOX_BROWSERS).sort().reverse()) {
      const candidate = join(SANDBOX_BROWSERS, entry, 'chrome-linux64', 'chrome');
      if (/^chromium-\d+$/.test(entry) && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** @param {import('@playwright/test').LaunchOptions} [options] */
export function launchChromium(options = {}) {
  const executablePath = chromiumPath();
  return chromium.launch({
    ...options,
    ...(executablePath === undefined ? {} : { executablePath }),
  });
}
