import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import definitions from '../../../../config/definitions.json';
import { mockApi, ok } from '../test/api-mock.js';
import type { MockRoutes } from '../test/api-mock.js';
import { noticeDetailFixture, NOTICE_ID } from '../test/fixtures-capital.js';
import {
  EXCEPTION_ID,
  exceptionFixture,
  exceptionPageFixture,
  exceptions,
} from '../test/fixtures-exceptions.js';
import { rolePrincipal } from '../test/fixtures-valuations.js';
import { BUILD_PATHS, REFERENCE } from '../test/copy-patterns.js';
import { renderWithQuery } from '../test/render.js';
import { AdminFlagsPage } from './AdminFlags.js';
import { AccessPage, HealthPage } from './admin/Admin.js';
import {
  analyticsFixture,
  capitalNoticesFixture,
  flagsFixture,
  mockUsersFixture,
  principalFixture,
  wallListFixture,
  watchlistFixture,
  weeklyReportFixture,
} from './assistants/test-support.js';
import { AssistantsPage } from './assistants/Assistants.js';
import { CapitalNoticePage } from './capital/NoticeDetail.js';
import { DataDictionaryPage } from './Data.js';
import { ExceptionDetailPage } from './exceptions/ExceptionDetail.js';
import { ExceptionsPage } from './exceptions/Exceptions.js';
import { ExtractionRunPage } from './extraction/ExtractionRun.js';
import { detailFixture, RUN_ID } from './extraction/test-fixtures.js';

/*
 * The second half of the copy guard (lib/copy-guard.test.ts reads the source): the pages whose
 * words come from the API, rendered from the test fixtures, never show a reference to the build
 * guide, a configuration file or a code path, and the pages that list keys show words in their
 * place. A sentence the API writes with a reference in it is given to each page that shows one
 * ("(SEC-8.10)", "(SEC-12.3)", "(ai.extraction)"), so a page that stopped removing it fails here.
 */

const route = vi.hoisted((): { id: string; search: Record<string, string> } => ({
  id: '',
  search: {},
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../test/router-mock.js')).routerMockWithSearch(),
  useParams: () => ({ id: route.id }),
  useSearch: () => route.search,
}));

const ME = '/api/v1/auth/me';

/** What a reader can see: the page's text and every tooltip. Accessible names are not read here. */
function visibleText(): string {
  const titles = [...document.body.querySelectorAll('[title]')].map(
    (el) => el.getAttribute('title') ?? '',
  );
  return [document.body.textContent ?? '', ...titles].join('\n');
}

/** Every line of the visible text that names the build, so a failure says where. */
function buildWords(): string[] {
  return visibleText()
    .split(/(?<=[.;\n])/)
    .filter((line) => REFERENCE.test(line) || BUILD_PATHS.test(line))
    .map((line) => line.trim());
}

/** The flags as the database seeds them: the AI switch cites its control. */
const flags = flagsFixture(true);

describe('rendered page copy', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('the flags page names each flag by its words, and its result line too', async () => {
    const extraction = flags.flags.find((f) => f.key === 'ai.extraction');
    expect(extraction?.description).toContain('(SEC-8.10)');
    const routes: MockRoutes = {
      [ME]: ok(principalFixture({ roles: ['platform_admin'] })),
      '/api/v1/flags': ok(flags),
      '/api/v1/flags/ai.extraction': ok({ ...extraction, enabled: true }),
    };
    mockApi(routes);
    renderWithQuery(<AdminFlagsPage />);
    await screen.findByRole('table', { name: 'Feature flags' });
    await userEvent.type(screen.getByLabelText('Reason for the next change'), 'ok!');
    await userEvent.click(screen.getByRole('switch', { name: 'ai.extraction enabled' }));
    expect(await screen.findByTestId('flag-message')).toHaveTextContent(
      'The switch for AI extraction calls is now on',
    );
    expect(buildWords()).toEqual([]);
    for (const f of flags.flags) expect(visibleText()).not.toContain(f.key);
  });

  it('access and walls, and integration health, show words for every key and no control', async () => {
    mockApi({
      '/api/v1/walls': ok(wallListFixture()),
      [ME]: ok(principalFixture()),
      '/api/v1/auth/mock-users': ok(mockUsersFixture()),
    });
    renderWithQuery(<AccessPage />);
    await screen.findByTestId('wall-10000000-0000-4000-8000-000000000081');
    expect(buildWords()).toEqual([]);
    cleanup();

    const checks = {
      database: { ok: true },
      'identity.mock': { ok: true, detail: 'mock' },
      'drop.local_folder.ops_drop': { ok: true },
      'ai.mock': { ok: false, detail: 'adapter disabled by kill switch (SEC-8.10)' },
    };
    mockApi({
      '/health/ready': ok({ status: 'degraded', version: '0.1.0', checks }),
      '/api/v1/flags': ok(flags),
    });
    renderWithQuery(<HealthPage />);
    await screen.findByRole('table', { name: 'Kill switches' });
    expect(screen.getByText('adapter disabled by kill switch')).toBeInTheDocument();
    expect(buildWords()).toEqual([]);
    const text = visibleText();
    for (const key of Object.keys(checks).filter((k) => k.includes('.')))
      expect(text).not.toContain(key);
    for (const f of flags.flags) expect(text).not.toContain(f.key);
    expect(text).not.toContain('ai.*');
  });

  it('the data dictionary shows the configured terms in words, with no key or file', async () => {
    mockApi({
      '/api/v1/data-dictionary': ok({ source: 'config/definitions.json', definitions }),
    });
    renderWithQuery(<DataDictionaryPage />);
    await screen.findByRole('table', { name: 'Definitions' });
    expect(buildWords()).toEqual([]);
    // Every key that reads as code (a capital inside it, an underscore, a dot) at every level.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [k, v] of Object.entries(value)) {
        if (/[a-z][A-Z]|_|\./.test(k)) keys.add(k);
        walk(v);
      }
    };
    walk(definitions);
    expect(keys.size).toBeGreaterThan(20);
    const text = visibleText();
    expect([...keys].filter((k) => text.includes(k))).toEqual([]);
  });

  it("the assistant's answer says who answered in words, not the library's line", async () => {
    mockApi({
      '/api/v1/flags': ok(flags),
      '/api/v1/analytics/summary': ok(analyticsFixture()),
      '/api/v1/monitoring/watchlist': ok(watchlistFixture()),
      '/api/v1/capital-notices': ok(capitalNoticesFixture()),
      '/api/v1/reports/weekly': ok(weeklyReportFixture()),
      '/api/v1/walls': ok(wallListFixture()),
    });
    renderWithQuery(<AssistantsPage />);
    await screen.findByText('On');
    await userEvent.click(screen.getByRole('button', { name: 'Which valuations are stale?' }));
    await screen.findByTestId('assistant-paragraphs');
    expect(screen.getByTestId('assistant-mock-line')).not.toBeEmptyDOMElement();
    expect(buildWords()).toEqual([]);
  });

  it('the exceptions queue and an exception show values in words', async () => {
    route.search = {};
    mockApi({ '/api/v1/data-exceptions': ok(exceptionPageFixture(exceptions())) });
    renderWithQuery(<ExceptionsPage />);
    await screen.findByRole('table', { name: 'Data exceptions' });
    expect(buildWords()).toEqual([]);
    expect(visibleText()).not.toMatch(/\b(?:sector|geography|doc_type|deal_type)\.[a-z]/);
    cleanup();

    route.id = EXCEPTION_ID.sector;
    const sector = exceptions().find((x) => x.id === EXCEPTION_ID.sector) ?? exceptionFixture();
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [`/api/v1/data-exceptions/${EXCEPTION_ID.sector}`]: ok(sector),
    });
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    expect(buildWords()).toEqual([]);
    expect(visibleText()).not.toMatch(/\b(?:sector|geography|doc_type|deal_type)\.[a-z]/);
  });

  it('an extraction run folds its model details into words, and its refusal drops the key', async () => {
    route.id = RUN_ID.succeeded;
    mockApi({
      [ME]: ok(rolePrincipal(['deal_team'])),
      [`/api/v1/extraction/runs/${RUN_ID.succeeded}`]: ok(detailFixture()),
    });
    renderWithQuery(<ExtractionRunPage />);
    await screen.findByTestId('run-banner');
    expect(buildWords()).toEqual([]);
    const run = detailFixture().run;
    expect(visibleText()).not.toContain(run.schemaId);
    expect(visibleText()).not.toContain(run.promptId);
  });

  it("a capital notice shows the API's notes without the control they cite", async () => {
    route.id = NOTICE_ID.extracted;
    mockApi({
      [ME]: ok(rolePrincipal(['operations'])),
      [`/api/v1/capital-notices/${NOTICE_ID.extracted}`]: ok(
        noticeDetailFixture({
          notes: [
            'Wire instructions changed on Jul 1, 2025; release is held until Jul 31, 2025 (SEC-12.3).',
          ],
        }),
      ),
    });
    renderWithQuery(<CapitalNoticePage />);
    await screen.findByTestId('notice-notes');
    expect(
      screen.getByText(
        'Wire instructions changed on Jul 1, 2025; release is held until Jul 31, 2025.',
      ),
    ).toBeInTheDocument();
    expect(buildWords()).toEqual([]);
  });
});
