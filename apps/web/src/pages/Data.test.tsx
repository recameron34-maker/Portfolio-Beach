import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { mockApi, ok } from '../test/api-mock.js';
import { dataHealthFixture, principalFixture } from '../test/fixtures.js';
import { renderWithQuery } from '../test/render.js';
import userEvent from '@testing-library/user-event';
import { DataDictionaryPage, DataHealthPage } from './Data.js';
import { dictionaryLines, nameWords, settingText } from './data-display.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../test/router-mock.js')).routerMock(),
);

const gaps = {
  ...dataHealthFixture(),
  vehiclesWithOwnershipGap: [{ vehicleName: 'Beach Co-Invest Fund III', ownershipTotal: '0.75' }],
};

const renderAs = (roles: string[], health = gaps) => {
  mockApi({
    '/api/v1/auth/me': ok({ ...principalFixture(), roles }),
    '/api/v1/data-health': ok(health),
  });
  renderWithQuery(<DataHealthPage />);
};

describe('Data Health: client ownership', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a role that sees every client the vehicles whose ownership misses 100%, as a percentage', async () => {
    renderAs(['operations']);
    expect(
      await screen.findByText('Beach Co-Invest Fund III: ownership sums to 75.0%'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ownership-not-checked')).not.toBeInTheDocument();
  });

  it('checks the ownership for the deal team too: the investment team sees every client (the decision of 2026-11-11)', async () => {
    for (const roles of [['deal_team'], ['approver'], ['deal_team', 'platform_admin']]) {
      renderAs(roles);
      expect(
        await screen.findByText('Beach Co-Invest Fund III: ownership sums to 75.0%'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('ownership-not-checked')).not.toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('never shows a partial sum as a data error to a role entitled to some clients or none', async () => {
    for (const roles of [['viewer'], ['investor_relations'], ['viewer', 'platform_admin']]) {
      renderAs(roles);
      expect(await screen.findByTestId('ownership-not-checked')).toHaveTextContent(
        'checked against 100% for operations, the investment team (the deal team and approvers) and auditors, who see every',
      );
      expect(screen.queryByText(/ownership sums to/)).not.toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('lists the checks with their counts and links open exceptions to the queue', async () => {
    renderAs(['operations']);
    const table = await screen.findByRole('table', { name: 'Data checks' });
    expect(screen.getByTestId('data-health-tiles')).toContainElement(table);
    const row = (name: string): HTMLElement => {
      const cell = within(table).getByRole('rowheader', { name });
      const tr = cell.closest('tr');
      if (tr === null) throw new Error(`no row for ${name}`);
      return tr;
    };
    expect(row('Open exceptions')).toHaveTextContent('Open exceptions');
    expect(
      within(row('Open exceptions')).getByRole('link', { name: 'Open the queue' }),
    ).toHaveAttribute('href', '/data/exceptions');
    expect(row('Stale positions')).toHaveTextContent('No approved financials in 75 days');
    expect(row('Locked valuations, latest quarter')).toBeInTheDocument();
    expect(row('Client ownership')).toHaveTextContent(
      'Beach Co-Invest Fund III: ownership sums to 75.0%',
    );
    // The page has the Admin tab row, and its title is in sentence case.
    expect(screen.getByRole('heading', { level: 1, name: 'Data health' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Admin' })).toHaveTextContent('Data health');
  });

  it('draws a dot only for a fault: a zero, or a count that is not one, has none', async () => {
    renderAs(['operations'], {
      ...dataHealthFixture(),
      orphanInvestments: 0,
      openExceptions: 2,
      staleInvestments: 0,
      vehiclesWithOwnershipGap: [],
    });
    const table = await screen.findByRole('table', { name: 'Data checks' });
    const tone = (name: string): string | null =>
      within(table)
        .getByRole('rowheader', { name })
        .closest('tr')
        ?.querySelector('.pb-check-result')
        ?.getAttribute('data-tone') ?? null;
    expect(tone('Orphan investments')).toBeNull();
    expect(tone('Open exceptions')).toBe('watch');
    expect(tone('Stale positions')).toBeNull();
    expect(tone('Locked valuations, latest quarter')).toBeNull();
    expect(tone('Client ownership')).toBe('good');
  });

  it('says every closed vehicle sums to 100% when a full-view role finds no gap', async () => {
    renderAs(['auditor'], dataHealthFixture());
    expect(
      await screen.findByText("Every closed vehicle's LP ownership sums to 100%."),
    ).toBeInTheDocument();
  });
});

describe('Data dictionary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** A few terms in the shape config/definitions.json gives them, notes and references included. */
  const definitions = {
    irr: { method: 'XIRR', showGrossAndNet: true, _note: 'Kept for the build (docs/08).' },
    currencyStorage:
      'dollars as exact decimals; AI outputs declare units; convert in packages/calc/units.ts',
    platformStack: 'Option B: custom Azure app + PostgreSQL or Azure SQL (docs/13).',
    rollForwardToleranceUsd: 1,
    watchlist: { ebitdaYoYDeclinePct: 0.15, netDebtToEbitdaMax: 6 },
    capitalActivity: { alertDaysBeforeDue: [3, 1, 0] },
    dealFit: { tierScores: { 'sponsor_tier.core': 100 } },
    _units: 'All percentages in this file are decimals (0.10 = 10%).',
  };

  it('writes a configured name in words', () => {
    expect(nameWords('rollForwardToleranceUsd')).toBe('Roll forward tolerance (USD)');
    expect(nameWords('ebitdaYoYDeclinePct')).toBe('EBITDA year over year decline percent');
    expect(nameWords('irr')).toBe('IRR');
    expect(nameWords('sponsor_tier.core')).toBe('Sponsor tier core');
    expect(nameWords('maxWorkbookBase64Chars')).toBe('Max workbook base64 chars');
    expect(nameWords('USD_K')).toBe('USD K');
  });

  it('shows a setting without its references or a clause that names a file', () => {
    expect(settingText(definitions.currencyStorage)).toBe(
      'dollars as exact decimals; AI outputs declare units',
    );
    expect(settingText(definitions.platformStack)).toBe(
      'Option B: custom Azure app + PostgreSQL or Azure SQL.',
    );
  });

  it('lays a term out as lines, its settings under it, and skips notes at every level', () => {
    expect(dictionaryLines('dealFit', definitions.dealFit)).toEqual([
      { path: 'dealFit', depth: 0, name: 'Deal fit', value: '' },
      { path: 'dealFit.tierScores', depth: 1, name: 'Tier scores', value: '' },
      {
        path: 'dealFit.tierScores.sponsor_tier.core',
        depth: 2,
        name: 'Sponsor tier core',
        value: '100',
      },
    ]);
    expect(dictionaryLines('irr', definitions.irr).map((l) => [l.name, l.value])).toEqual([
      ['IRR', ''],
      ['Method', 'XIRR'],
      ['Show gross and net', 'Yes'],
    ]);
    expect(dictionaryLines('_units', definitions._units)).toEqual([]);
  });

  it('reads as words: no configuration name, no file, no raw object', async () => {
    mockApi({
      '/api/v1/data-dictionary': ok({ source: 'config/definitions.json', definitions }),
    });
    renderWithQuery(<DataDictionaryPage />);
    const table = await screen.findByRole('table', { name: 'Definitions' });
    expect(screen.getByRole('heading', { level: 1, name: 'Data dictionary' })).toBeInTheDocument();
    // The units note is a "_" name like any other, so the page does not restate it.
    expect(screen.getByText('7 terms.')).toBeInTheDocument();
    expect(screen.queryByText(/Percentages are written as decimals/)).toBeNull();
    const text = document.body.textContent ?? '';
    for (const key of ['currencyStorage', 'rollForwardToleranceUsd', 'ebitdaYoYDeclinePct'])
      expect(text).not.toContain(key);
    expect(text).not.toMatch(/config\/|packages\/|docs\/|\{"/);
    expect(text).not.toContain('Kept for the build');
    // Arrays read as a list; nested settings sit under their term.
    const alert = within(table).getByRole('rowheader', { name: 'Alert days before due' });
    expect(alert.closest('tr')).toHaveTextContent('3, 1, 0');
    expect(alert).toHaveAttribute('data-depth', '1');
    // The filter matches a term's words or anything shown under it.
    await userEvent.type(screen.getByLabelText('Filter terms'), 'azure');
    expect(screen.getByTestId('dictionary-count')).toHaveTextContent('1 of 7 terms match');
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Platform stack']);
  });
});
