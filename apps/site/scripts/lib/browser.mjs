/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts and the check */
// Launches the Chromium the media scripts and the check drive. PW_CHROMIUM_PATH wins; otherwise
// Playwright's own browser; when that one is not installed, a preinstalled build under the
// browsers folder of a cloud sandbox is used. Also finds the ffmpeg that encodes the recordings.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * The ffmpeg that encodes a recording again at a lower bitrate, or null when there is none.
 * PB_FFMPEG wins; then the build Playwright installs beside its browsers (it reads and writes
 * WebM with VP8, which is all the recordings need); then one on the PATH.
 */
export function ffmpegPath() {
  const override = process.env.PB_FFMPEG;
  if (override !== undefined && override !== '') return existsSync(override) ? override : null;
  const folders = [process.env.PLAYWRIGHT_BROWSERS_PATH];
  try {
    // .../<browsers>/chromium-1234/chrome-linux64/chrome: the browsers folder is three levels up.
    folders.push(dirname(dirname(dirname(chromium.executablePath()))));
  } catch {
    // No browser of Playwright's own: the other folders are tried.
  }
  folders.push(
    SANDBOX_BROWSERS,
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
  );
  for (const folder of folders) {
    if (folder === undefined || folder === '' || !existsSync(folder)) continue;
    for (const entry of readdirSync(folder).sort().reverse()) {
      if (!/^ffmpeg-\d+$/.test(entry)) continue;
      for (const name of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe']) {
        const candidate = join(folder, entry, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const onPath = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return onPath.status === 0 ? 'ffmpeg' : null;
}
