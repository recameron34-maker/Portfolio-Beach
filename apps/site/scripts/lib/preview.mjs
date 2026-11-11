/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts; the shapes are written as JSDoc */
// Drives the interactive preview (apps/web/dist-preview) for the media scripts: a static server,
// sign-in through the prototype picker, the role switcher, hash navigation that never reloads the
// page (the preview keeps its simulated state in memory for the page session only) and calls to
// the preview's own API from inside the page, as apps/web/scripts/probe-preview.mjs makes them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = resolve(here, '..', '..');
export const REPO_DIR = resolve(SITE_DIR, '..', '..');
export const PREVIEW_DIR = resolve(
  process.env.PB_PREVIEW_OUT ?? join(REPO_DIR, 'apps', 'web', 'dist-preview'),
);
export const MEDIA_DIR = join(SITE_DIR, 'media');

export function previewExists() {
  return existsSync(join(PREVIEW_DIR, 'index.html'));
}

/** The as-of date the preview was recorded on (the clock its pages and rules read). */
export function previewAsOf() {
  const fixtures = JSON.parse(readFileSync(join(PREVIEW_DIR, 'preview', 'fixtures.json'), 'utf8'));
  if (typeof fixtures.asOf !== 'string')
    throw new Error('the preview recordings carry no as-of date');
  return fixtures.asOf;
}

/** Serves the preview; fails with the command that builds it when it is missing. */
export async function servePreview() {
  if (!previewExists())
    throw new Error(
      `the preview is not built: ${PREVIEW_DIR} has no index.html. Run "node scripts/build-preview.mjs" in apps/web, or "pnpm --filter @pb/site build".`,
    );
  return serveStatic(PREVIEW_DIR);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} origin
 */
export function previewDriver(page, origin) {
  /** @type {Map<string, { externalId: string, displayName: string, roles: string[] }>} */
  const users = new Map();

  /**
   * The shim answers inside the page, so these requests never reach the network: wait until it
   * has nothing in flight and has answered nothing new for a quiet spell.
   */
  async function settle(quietMs = 350, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      const a = await page.evaluate(
        () => globalThis.__pbPreviewActivity ?? { inflight: 0, total: 0 },
      );
      if (a.inflight > 0 || a.total !== last) {
        last = a.total;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`the preview did not settle at ${page.url()}`);
  }

  /** Sends a request to the preview's API as a credential, without changing whom the page acts as. */
  function api(credential, method, path, body) {
    return page.evaluate(
      async ({ credential, method, path, body }) => {
        let signedIn = null;
        try {
          signedIn = globalThis.sessionStorage.getItem('pb.credential');
          globalThis.sessionStorage.setItem('pb.credential', credential);
        } catch {
          // Storage blocked: the header below still carries the credential.
        }
        const headers = { accept: 'application/json', authorization: `Bearer ${credential}` };
        if (body !== null) headers['content-type'] = 'application/json';
        let res;
        try {
          res = await globalThis.fetch(path, {
            method,
            headers,
            ...(body === null ? {} : { body: JSON.stringify(body) }),
          });
        } finally {
          try {
            if (signedIn === null) globalThis.sessionStorage.removeItem('pb.credential');
            else globalThis.sessionStorage.setItem('pb.credential', signedIn);
          } catch {
            // Storage blocked: nothing was changed.
          }
        }
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON (a CSV export, an empty body).
        }
        return { status: res.status, json, text };
      },
      { credential, method, path, body: body ?? null },
    );
  }

  /** A read that must answer 200; the error names the request, never the body. */
  async function read(credential, path) {
    const answer = await api(credential, 'GET', path);
    if (answer.status !== 200)
      throw new Error(`GET ${path} as ${credential} answered ${answer.status}`);
    return answer.json;
  }

  /** A write that must succeed. */
  async function send(credential, method, path, body) {
    const answer = await api(credential, method, path, body);
    if (answer.status < 200 || answer.status >= 300)
      throw new Error(
        `${method} ${path} as ${credential} answered ${answer.status}: ${answer.json?.detail ?? ''}`,
      );
    return answer.json;
  }

  function user(externalId) {
    const found = users.get(externalId);
    if (found === undefined) throw new Error(`the preview has no mock user ${externalId}`);
    return found;
  }

  /** Opens the sign-in page (a full load: the preview starts from its recorded state). */
  async function open() {
    await page.goto(`${origin}/#/sign-in`);
    await page.getByTestId('mock-user-list').waitFor();
    if (users.size === 0) {
      const list = await page.evaluate(async () => {
        const res = await globalThis.fetch('/api/v1/auth/mock-users', {
          headers: { accept: 'application/json' },
        });
        return res.json();
      });
      for (const u of list.users ?? []) users.set(u.externalId, u);
    }
  }

  /** Signs in through the picker. The page must already be on the sign-in route. */
  async function signIn(externalId) {
    if (!page.url().includes('#/sign-in')) await go('/sign-in', { settle: false });
    await page.getByTestId('mock-user-list').waitFor();
    await page.getByRole('button', { name: new RegExp(user(externalId).displayName) }).click();
    await page
      .getByTestId('current-user')
      .filter({ hasText: user(externalId).displayName })
      .waitFor();
    await settle();
  }

  /** Switches the acting user through the role switcher in the header. */
  async function switchUser(externalId) {
    await page.getByTestId('role-switcher').click();
    await page.getByRole('option', { name: new RegExp(user(externalId).displayName) }).click();
    await page
      .getByTestId('current-user')
      .filter({ hasText: user(externalId).displayName })
      .waitFor();
    await settle();
  }

  /** Navigates by the URL hash: the same document, so the session's simulated state is kept. */
  async function go(route, options = {}) {
    await page.goto(`${origin}/#${route}`);
    if (options.settle !== false) await settle();
  }

  return { users, user, open, signIn, switchUser, go, settle, api, read, send };
}

/** The latest calendar quarter end on or before an ISO date. */
export function quarterEndOnOrBefore(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const ends = [
    [3, 31],
    [6, 30],
    [9, 30],
    [12, 31],
  ];
  for (let i = ends.length - 1; i >= 0; i -= 1) {
    const [em, ed] = ends[i];
    if (m > em || (m === em && d >= ed)) return `${y}-${String(em).padStart(2, '0')}-${ed}`;
  }
  return `${y - 1}-12-31`;
}

/** A date as the pages show it, for example "Jun 30, 2025". */
export function shownDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
