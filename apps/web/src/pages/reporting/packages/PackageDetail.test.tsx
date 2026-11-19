import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportPackageDetail, ReportPackageLine } from '@pb/contracts';
import type { MockRoutes } from '../../../test/api-mock.js';
import { failing, mockApi, ok } from '../../../test/api-mock.js';
import { investmentPageFixture } from '../../../test/fixtures.js';
import {
  CLIENT_ID,
  generatedDetailFixture,
  overriddenDetailFixture,
  packageContentFixture,
  packageDetailFixture,
  PKG_ID,
  PKG_PERIOD,
  PKG_PERSON,
} from '../../../test/fixtures-packages.js';
import { activePositions } from '../../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../../test/render.js';
import { PackageDetailPage } from './PackageDetail.js';
import { NET_NOTICE, NEXT_STEP_WORDS, NO_END_MARK, NO_START_MARK } from './packages.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const detailPath = (id: string): string => `/api/v1/report-packages/${id}`;

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const POSITIONS = '/api/v1/investments';

function open(detail: ReportPackageDetail, extra: MockRoutes = {}): void {
  params.id = detail.id;
  mockApi({ [detailPath(detail.id)]: ok(detail), ...extra });
  renderWithQuery(<PackageDetailPage />);
}

/** The body rows of a table, each as the text of its cells. */
function cellsOf(table: string): string[][] {
  return within(screen.getByRole('table', { name: table }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''));
}

/** The one row of the Checks table for a check and what it is about. */
function checkRow(check: string, about: string): string[] {
  const rows = cellsOf('Checks').filter((cells) => cells[1] === check && cells[2] === about);
  expect(rows, `${check} about ${about}`).toHaveLength(1);
  return rows[0]!;
}

async function showPassed(count: number): Promise<void> {
  await userEvent.click(
    screen.getByRole('button', { name: `Show the ${count} checks that passed` }),
  );
}

/** The cards that hold what a generation writes. */
const GENERATED_CARDS = [
  'package-checks',
  'package-positions',
  'package-footnotes',
  'package-client-share',
  'package-explanations',
  'package-change-log',
];

/** The steps of the gate as "name: where it stands". */
function gate(): string[] {
  const strip = screen.getByRole('list', { name: 'Release gate' });
  return within(strip)
    .getAllByRole('listitem')
    .map((li) => `${li.firstElementChild?.textContent ?? ''}: ${li.getAttribute('data-status')}`);
}

describe('a reporting package page', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a draft on its header and the first step of the gate', async () => {
    open(packageDetailFixture());
    const banner = await screen.findByTestId('package-banner');
    expect(
      within(banner).getByRole('heading', { level: 1, name: 'Client Alpha Pension: Q2 2025' }),
    ).toBeInTheDocument();
    expect(banner).toHaveTextContent('Net');
    expect(banner).toHaveTextContent('Preliminary');
    expect(banner).toHaveTextContent('Version 1');
    expect(banner).toHaveTextContent('As of Aug 15, 2025');
    expect(within(banner).getByText('Draft')).toHaveClass('pb-badge-neutral');
    // The state leads the meta line, and the commands that move the package sit in the header.
    expect(banner.querySelector('.pb-meta-list > span:first-child')).toHaveTextContent('Draft');
    expect(within(banner).getByTestId('package-actions')).toBeInTheDocument();
    expect(within(screen.getByTestId('package-gate')).queryByRole('button')).toBeNull();
    // The trail leads back to Reporting and to the list.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Reporting' })).toHaveAttribute(
      'href',
      '/reporting',
    );
    expect(within(trail).getByRole('link', { name: 'Packages' })).toHaveAttribute(
      'href',
      '/reporting/packages',
    );
    expect(gate()).toEqual([
      'Draft: current',
      'Generated: upcoming',
      'QA: upcoming',
      'In review: upcoming',
      'Approved: upcoming',
      'Released: upcoming',
    ]);
    expect(screen.getByTestId('package-next')).toHaveTextContent(NEXT_STEP_WORDS.Draft);
    const who = screen.getByRole('table', { name: 'Who moved the package' });
    expect(within(who).getByRole('row', { name: /Prepared by/ })).toHaveTextContent(
      'Imogen Tavares',
    );
    expect(within(who).getByRole('row', { name: /Checks/ })).toHaveTextContent('Not run');
    // Nobody approved or released it yet: the placeholder, never a guess.
    expect(within(who).getByRole('row', { name: /Approved by/ })).toHaveTextContent('Approved by-');
    expect(within(who).getByRole('row', { name: /Released by/ })).toHaveTextContent('Released by-');
    expect(within(who).queryByText('Reason for this version')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(IDENTIFIER);
  });

  it('says of a net package that its figures are gross until net is worked out', async () => {
    open(packageDetailFixture());
    expect(await screen.findByTestId('package-net-notice')).toHaveTextContent(NET_NOTICE);
    cleanup();
    vi.restoreAllMocks();
    open(generatedDetailFixture());
    await screen.findByTestId('package-banner');
    expect(screen.queryByTestId('package-net-notice')).not.toBeInTheDocument();
  });

  it('puts a failed QA on the QA step and says who can move it on', async () => {
    open(generatedDetailFixture());
    const banner = await screen.findByTestId('package-banner');
    expect(within(banner).getByText('QA failed')).toHaveClass('pb-badge-bad');
    expect(gate()).toEqual([
      'Draft: done',
      'Generated: done',
      'QA failed: current',
      'In review: upcoming',
      'Approved: upcoming',
      'Released: upcoming',
    ]);
    expect(screen.getByTestId('package-next')).toHaveTextContent(
      'Investor relations regenerates the package once the record is fixed, or an approver overrides the failed checks with a reason.',
    );
    expect(
      within(screen.getByRole('table', { name: 'Who moved the package' })).getByRole('row', {
        name: /Checks/,
      }),
    ).toHaveTextContent('1 of 26 failed');
    expect(document.body.textContent).not.toMatch(IDENTIFIER);
  });

  it('says there is no way back once the checks have passed, by override or not', async () => {
    const overridden = generatedDetailFixture();
    const findings = overridden.findings.map((f) =>
      f.passed
        ? f
        : {
            ...f,
            override: {
              reason: 'The stale mark is disclosed in the cover letter.',
              approver: PKG_PERSON.approver,
              at: '2025-08-16T09:00:00.000Z',
            },
          },
    );
    open({
      ...overridden,
      state: 'QAPassed',
      findings,
      qa: { ...overridden.qa, overridden: overridden.qa.failed },
      rowVersion: 4,
    });
    await screen.findByTestId('package-banner');
    expect(gate()[2]).toBe('QA passed by override: current');
    expect(screen.getByTestId('package-next')).toHaveTextContent('There is no way back from here');
    expect(
      within(screen.getByRole('table', { name: 'Who moved the package' })).getByRole('row', {
        name: /Checks/,
      }),
    ).toHaveTextContent('1 failed, overridden');
  });

  it('names who approved and who released a package, with the time, and why a version was started', async () => {
    open(
      generatedDetailFixture({
        id: PKG_ID.released,
        version: 2,
        state: 'Released',
        label: 'preliminary',
        reviewer: PKG_PERSON.approver,
        approvedAt: '2025-08-18T14:05:00.000Z',
        releasedBy: PKG_PERSON.operations,
        releasedAt: '2025-08-19T08:30:00.000Z',
        correctionReason: 'The June mark of one position was restated.',
        contentHash: 'a'.repeat(64),
        rowVersion: 7,
      }),
    );
    const banner = await screen.findByTestId('package-banner');
    expect(within(banner).getByText('Released')).toHaveClass('pb-badge-good');
    expect(gate()[5]).toBe('Released: current');
    expect(
      gate()
        .slice(0, 5)
        .every((step) => step.endsWith(': done')),
    ).toBe(true);
    const who = screen.getByRole('table', { name: 'Who moved the package' });
    expect(within(who).getByRole('row', { name: /Approved by/ })).toHaveTextContent(
      'Morgan Lindqvist, Aug 18, 2025 14:05:00 UTC',
    );
    expect(within(who).getByRole('row', { name: /Released by/ })).toHaveTextContent(
      'Avery Mbeki, Aug 19, 2025 08:30:00 UTC',
    );
    expect(within(who).getByRole('row', { name: /Reason for this version/ })).toHaveTextContent(
      'The June mark of one position was restated.',
    );
    expect(screen.getByTestId('package-next')).toHaveTextContent('Released packages are read only');
  });

  it('reads a package of a client the reader does not read as not found', async () => {
    params.id = PKG_ID.draft;
    mockApi({ [detailPath(PKG_ID.draft)]: failing(404, detailPath(PKG_ID.draft)) });
    renderWithQuery(<PackageDetailPage />);
    expect(await screen.findByText('Package not found')).toBeInTheDocument();
    expect(screen.getByTestId('error-state')).toHaveTextContent(
      'There is no package at this address among the clients you read.',
    );
    // The page keeps its header and trail, so the reader can go back to the list.
    expect(screen.getByRole('heading', { level: 1, name: 'Client package' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Packages',
      }),
    ).toHaveAttribute('href', '/reporting/packages');
    expect(document.body.textContent).not.toMatch(IDENTIFIER);
  });

  it('tells a role that reads no package that it is not visible to the role', async () => {
    params.id = PKG_ID.draft;
    mockApi({ [detailPath(PKG_ID.draft)]: failing(403, detailPath(PKG_ID.draft)) });
    renderWithQuery(<PackageDetailPage />);
    expect(await screen.findByText('This package: not visible to your role')).toBeInTheDocument();
    expect(screen.getByTestId('package-unavailable')).toHaveTextContent(
      'Investor relations read the packages of the clients they are entitled to',
    );
  });
});

describe('the cards of a reporting package', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('reads every card of a draft as not generated yet, with no figure and no table', async () => {
    open(packageDetailFixture());
    await screen.findByTestId('package-banner');
    for (const card of GENERATED_CARDS) {
      expect(screen.getByTestId(card), card).toHaveTextContent('Not generated yet');
      expect(within(screen.getByTestId(card)).queryByRole('table'), card).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('package-hash')).not.toBeInTheDocument();
    expect(screen.getByTestId('action-log')).toHaveTextContent('No actions yet');
    // Nothing on the page stands in for a figure that does not exist yet.
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('shows the failed check with what it expected and found, and the passed ones behind a toggle', async () => {
    open(generatedDetailFixture());
    const checks = await screen.findByTestId('package-checks');
    expect(checks).toHaveTextContent('Run 1');
    expect(
      within(screen.getByRole('table', { name: 'Checks' }))
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Result', 'Check', 'About', 'Expected', 'Found', 'Detail']);
    // Labelled final over a stale mark: expected preliminary, found final.
    expect(cellsOf('Checks')).toEqual([
      [
        'Failed',
        'Preliminary or final, gross or net',
        'Preliminary or final label',
        'Preliminary',
        'Final',
        'The package says final while a position carries a mark for an earlier period.',
      ],
    ]);
    expect(within(checks).getByText('Failed')).toHaveClass('pb-badge-bad');
    const toggle = screen.getByRole('button', { name: 'Show the 25 checks that passed' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // A quiet toggle whose chevron turns when the rows are shown.
    expect(toggle.querySelector('.pb-pkg-toggle-chevron')).not.toBeNull();
    await userEvent.click(toggle);
    const rows = cellsOf('Checks');
    expect(rows).toHaveLength(26);
    // Only the rows the reader asked for carry the class that fades them in.
    const bodyRows = within(screen.getByRole('table', { name: 'Checks' }))
      .getAllByRole('row')
      .slice(1);
    expect(bodyRows.map((tr) => tr.classList.contains('pb-pkg-passed'))).toEqual([
      false,
      ...Array<boolean>(25).fill(true),
    ]);
    // The failed check stays first; every other row passed.
    expect(rows[0]![0]).toBe('Failed');
    expect(rows.slice(1).every((cells) => cells[0] === 'Passed')).toBe(true);
    const hide = screen.getByRole('button', { name: 'Hide the checks that passed' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(hide);
    expect(cellsOf('Checks')).toHaveLength(1);
  });

  it('shows the three stored lines of a package, with no totals row', async () => {
    open(generatedDetailFixture());
    const positions = await screen.findByTestId('package-positions');
    expect(positions).toHaveTextContent('3 positions');
    expect(screen.getByTestId('package-positions-note')).toHaveTextContent(
      'Built from the positions Imogen Tavares could read when it was generated. A position behind an information wall that person is not on is not included.',
    );
    expect(
      within(screen.getByRole('table', { name: 'Positions' }))
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'Position',
      'Begin NAV',
      'Contributions',
      'Distributions',
      'Gain or loss',
      'End NAV',
      'Mark',
    ]);
    expect(cellsOf('Positions')).toEqual([
      // Held and marked for the quarter.
      ['INV-0001', '$11.9M', '$0.3M', '$0.0M', '$0.3M', '$12.5M', 'Quarter end'],
      // No locked mark for the quarter: the prior mark less the quarter's distribution.
      ['INV-0002', '$4.2M', '$0.0M', '$0.1M', '$0.0M', '$4.1M', 'Rolled forward from Mar 31, 2025'],
      // Entered in the quarter: no begin NAV, and not a begin NAV of zero.
      ['INV-0003', 'New this quarter', '$8.0M', '$0.0M', '$0.3M', '$8.3M', 'Quarter end'],
    ]);
    // The quarter end's own mark reads quiet, so the roll-forward stands out; no figure is missing.
    expect(
      within(screen.getByRole('table', { name: 'Positions' }))
        .getAllByRole('cell')
        .filter((td) => td.classList.contains('pb-pkg-mark-default'))
        .map((td) => td.textContent),
    ).toEqual(['Quarter end', 'Quarter end']);
    expect(screen.queryByTestId('package-positions-notes')).not.toBeInTheDocument();
    expect(cellsOf('Footnotes')).toEqual([
      ['INV-0002', 'Carried at the mark of Mar 31, 2025, rolled forward for cash flows since.'],
    ]);
    // The client owns 20% of the vehicle: its share of each end NAV, as stored.
    expect(cellsOf('Client share')).toEqual([
      ['INV-0001', '20.0%', '$2.5M'],
      ['INV-0002', '20.0%', '$0.8M'],
      ['INV-0003', '20.0%', '$1.7M'],
    ]);
    expect(screen.queryByTestId('package-client-share-gaps')).not.toBeInTheDocument();
    expect(positions).not.toHaveTextContent(/total/i);
  });

  it('shows the figures of the three lines to the cent where a check compares them', async () => {
    open(generatedDetailFixture());
    await screen.findByTestId('package-checks');
    await showPassed(25);
    // Line 1: 12,450,950.25 - 11,900,000.00 - 300,000.00 + 0.00 = 250,950.25.
    expect(checkRow('NAV roll-forward', 'INV-0001').slice(3, 5)).toEqual([
      '$12,450,950.25',
      '$12,450,950.25',
    ]);
    expect(checkRow('Gain or loss sign', 'INV-0001').slice(3, 5)).toEqual([
      '$250,950.25',
      '$250,950.25',
    ]);
    expect(checkRow('Quarter starts from the prior locked mark', 'INV-0001').slice(3, 5)).toEqual([
      '$11,900,000.00',
      '$11,900,000.00',
    ]);
    // Line 2: 4,200,000.00 + 0.00 - 125,000.50 = 4,074,999.50, a gain of 0.00, 20% is 814,999.90.
    expect(checkRow('End NAV on record', 'INV-0002')[4]).toBe('$4,074,999.50');
    expect(checkRow('Gain or loss sign', 'INV-0002').slice(3, 5)).toEqual(['$0.00', '$0.00']);
    expect(checkRow('Client share of NAV', 'INV-0002').slice(3, 5)).toEqual([
      '$814,999.90',
      '$814,999.90',
    ]);
    expect(checkRow('Stale mark footnoted', 'INV-0002').slice(3, 5)).toEqual([
      'Jun 30, 2025',
      'Mar 31, 2025',
    ]);
    // Line 3: entered in the quarter, 8,310,000.00 - 8,000,000.00 = 310,000.00.
    expect(checkRow('Gain or loss sign', 'INV-0003').slice(3, 5)).toEqual([
      '$310,000.00',
      '$310,000.00',
    ]);
    expect(checkRow('End NAV on record', 'INV-0003')[4]).toBe('$8,310,000.00');
    // A check with nothing to expect shows the placeholder, never zero.
    expect(checkRow('End NAV on record', 'INV-0003')[3]).toBe('-');
    expect(checkRow('Nothing dated after the as-of date', 'Whole package').slice(3, 5)).toEqual([
      'Aug 15, 2025',
      'Jun 30, 2025',
    ]);
    expect(checkRow('Movers list', 'Whole package').slice(3, 5)).toEqual([
      'INV-0001, INV-0002',
      'INV-0001, INV-0002',
    ]);
    // No rule code and no id among all 26 rows: a client line reads as its position.
    expect(document.body.textContent).not.toMatch(IDENTIFIER);
    expect(document.body.textContent).not.toContain(CLIENT_ID.alpha);
  });

  it('shows the placeholder, with the reason, for a begin NAV or an end NAV the record does not hold', async () => {
    const base = packageContentFixture();
    const line = (overrides: Partial<ReportPackageLine>): ReportPackageLine => ({
      ...base.lines[0]!,
      ...overrides,
    });
    const content = packageContentFixture({
      status: 'preliminary',
      lines: [
        // Held, with no locked mark at the start of the quarter: no begin NAV and no gain.
        line({ ref: 'INV-0004', beginNav: null, gainLoss: null, recordedQuarterStartNav: null }),
        // No mark at all on or before the quarter end: no end NAV, and no client line.
        line({
          ref: 'INV-0005',
          beginNav: null,
          contributions: '0',
          gainLoss: null,
          endNav: null,
          endNavPeriodEnd: null,
          recordedQuarterStartNav: null,
          latestFigureDate: null,
        }),
      ],
      movers: [],
      footnotes: [],
      clientLines: [
        { clientRef: CLIENT_ID.alpha, ref: 'INV-0004', ownershipPct: '0.2', nav: '2490190.05' },
      ],
    });
    open(generatedDetailFixture({ label: 'preliminary' }, content));
    await screen.findByTestId('package-positions');
    // Each placeholder carries the letter of its reason, said once under the table.
    const noStart = `-a ${NO_START_MARK}`;
    const noEnd = `-b ${NO_END_MARK}`;
    expect(cellsOf('Positions')).toEqual([
      ['INV-0004', noStart, '$0.3M', '$0.0M', noStart, '$12.5M', 'Quarter end'],
      ['INV-0005', noStart, '$0.0M', '$0.0M', noEnd, noEnd, noEnd],
    ]);
    expect(
      within(screen.getByTestId('package-positions-notes'))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([`a. ${NO_START_MARK}`, `b. ${NO_END_MARK}`]);
    // The letter is drawn for the eye; a screen reader hears the reason in the cell instead.
    for (const letter of screen.getByRole('table', { name: 'Positions' }).querySelectorAll('sup'))
      expect(letter).toHaveAttribute('aria-hidden', 'true');
    // What a reader sees is the placeholder alone; the reason is its title.
    const table = screen.getByRole('table', { name: 'Positions' });
    const missing = [...table.querySelectorAll('td.is-missing')];
    expect(missing.map((td) => td.getAttribute('title'))).toEqual([
      NO_START_MARK,
      NO_START_MARK,
      NO_START_MARK,
      NO_END_MARK,
      NO_END_MARK,
      NO_END_MARK,
    ]);
    for (const td of missing) expect(td.firstChild?.textContent).toBe('-');
    // Never zero, and never another quarter's figure, in a cell with no figure.
    expect(cellsOf('Positions')[1]!.slice(4)).not.toContain('$0.0M');
    expect(cellsOf('Client share')).toEqual([['INV-0004', '20.0%', '$2.5M']]);
    expect(screen.getByTestId('package-client-share-gaps')).toHaveTextContent(
      '1 position of the package has no client line: no end NAV, or no ownership share on record.',
    );
    expect(screen.getByTestId('package-footnotes')).toHaveTextContent('No footnotes');
    // The checks say the same: failed, with the placeholder for what is not there.
    expect(checkRow('End NAV on record', 'INV-0005').slice(0, 1)).toEqual(['Failed']);
    expect(checkRow('End NAV on record', 'INV-0005').slice(3, 5)).toEqual(['-', '-']);
    expect(checkRow('Quarter starts from the prior locked mark', 'INV-0004').slice(3, 5)).toEqual([
      '-',
      '-',
    ]);
  });

  it('names a position by its company when the reader can list it, and by its number alone when not', async () => {
    open(generatedDetailFixture(), { [POSITIONS]: ok(investmentPageFixture(activePositions())) });
    await screen.findByTestId('package-positions');
    // The list answers after the package: the name joins the number once it has.
    await waitFor(() =>
      expect(cellsOf('Positions')[0]![0]).toBe('INV-0001 Meridian Data Partners'),
    );
    expect(cellsOf('Positions').map((cells) => cells[0])).toEqual([
      'INV-0001 Meridian Data Partners',
      'INV-0002',
      'INV-0003',
    ]);
    expect(cellsOf('Client share')[0]![0]).toBe('INV-0001 Meridian Data Partners');
    await showPassed(25);
    expect(checkRow('NAV roll-forward', 'INV-0001 Meridian Data Partners')[0]).toBe('Passed');
    expect(checkRow('Movers list', 'Whole package')[3]).toBe(
      'INV-0001 Meridian Data Partners, INV-0002',
    );
    expect(checkRow('Client share of NAV', 'INV-0001 Meridian Data Partners')[0]).toBe('Passed');
  });

  it('says an override once, with who, when and why, and marks the check it covers', async () => {
    open(overriddenDetailFixture());
    const checks = await screen.findByTestId('package-checks');
    expect(screen.getByTestId('package-override')).toHaveTextContent(
      '1 failed check overridden by Morgan Lindqvist, Aug 16, 2025 09:00:00 UTC. Reason: The stale mark is disclosed in the cover letter.',
    );
    expect(cellsOf('Checks').map((cells) => cells[0])).toEqual(['Overridden']);
    expect(within(checks).getByText('Overridden')).toHaveClass('pb-badge-watch');
    expect(screen.queryByTestId('package-checks-passed')).not.toBeInTheDocument();
  });

  it('says that every check passed and keeps them behind the toggle', async () => {
    const content = packageContentFixture({ status: 'preliminary' });
    open(generatedDetailFixture({ label: 'preliminary' }, content));
    await screen.findByTestId('package-checks');
    expect(screen.getByTestId('package-checks-passed')).toHaveTextContent('All 26 checks passed.');
    expect(screen.queryByRole('table', { name: 'Checks' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-override')).not.toBeInTheDocument();
    await showPassed(26);
    expect(cellsOf('Checks')).toHaveLength(26);
  });

  it('shows the hash of the content in full once the package is approved, and not before', async () => {
    const hash = 'a1b2c3d4'.repeat(8);
    open(
      overriddenDetailFixture({
        state: 'Approved',
        reviewer: PKG_PERSON.approver,
        approvedAt: '2025-08-18T14:05:00.000Z',
        contentHash: hash,
        rowVersion: 6,
      }),
    );
    const shown = await screen.findByTestId('package-hash');
    expect(shown).toHaveTextContent('Content hash (SHA-256)');
    expect(shown).toHaveTextContent(hash);
    expect(shown).toHaveTextContent('Taken over everything this package shows, as approved.');
    cleanup();
    vi.restoreAllMocks();
    open(overriddenDetailFixture({ state: 'InReview', rowVersion: 5 }));
    await screen.findByTestId('package-banner');
    expect(screen.queryByTestId('package-hash')).not.toBeInTheDocument();
  });

  it('lists the tie-out explanations by position and says what a begin NAV is tied to', async () => {
    open(generatedDetailFixture());
    const first = await screen.findByTestId('package-explanations');
    expect(first).toHaveTextContent(
      'No earlier package was released to this client on this basis, so there is nothing to tie to.',
    );
    // With nothing to tie to, the sentence says why and no empty table or second line follows.
    expect(within(first).queryByRole('table')).not.toBeInTheDocument();
    expect(first).not.toHaveTextContent('No explanations recorded');
    cleanup();
    vi.restoreAllMocks();
    const explanations = {
      'INV-0002': 'A late distribution was booked to the prior quarter.',
      'INV-0001': 'The March mark was restated after the release.',
    };
    const content = packageContentFixture({
      priorRelease: {
        endNav: { 'INV-0001': '11500000', 'INV-0002': '4300000' },
        explanations,
      },
    });
    open(generatedDetailFixture({ tieOutExplanations: explanations }, content));
    const card = await screen.findByTestId('package-explanations');
    expect(card).toHaveTextContent(
      'Each begin NAV is tied to the end NAV of the last package released to this client on this basis.',
    );
    expect(cellsOf('Tie-out explanations')).toEqual([
      ['INV-0001', 'The March mark was restated after the release.'],
      ['INV-0002', 'A late distribution was booked to the prior quarter.'],
    ]);
    // An explained difference passes its tie-out: last released against this begin NAV, to the cent.
    // With a release to tie to, each line has its own tie-out, so the run has 28 checks.
    await showPassed(27);
    expect(checkRow('Ties to the last released package', 'INV-0001').slice(3, 5)).toEqual([
      '$11,500,000.00',
      '$11,900,000.00',
    ]);
  });

  it('lists the generation runs newest first and says where the other steps are', async () => {
    const detail = generatedDetailFixture();
    const first = detail.changeLog[0]!;
    open({
      ...detail,
      changeLog: [
        first,
        { ...first, at: '2025-08-16T08:00:00.000Z', by: PKG_PERSON.operations, runNo: 2 },
      ],
    });
    const log = await screen.findByTestId('package-change-log');
    expect(log).toHaveTextContent('Generation runs. Every other step is in the audit trail.');
    expect(log).toHaveTextContent('Newest first');
    expect(
      within(screen.getByRole('table', { name: 'Change log' }))
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Run', 'When', 'By', 'Positions', 'Checks', 'Failed']);
    expect(cellsOf('Change log')).toEqual([
      ['Run 2', 'Aug 16, 2025 08:00:00 UTC', 'Avery Mbeki', '3', '26', '1'],
      ['Run 1', 'Aug 15, 2025 10:12:00 UTC', 'Imogen Tavares', '3', '26', '1'],
    ]);
    // The figures are the reading of whoever ran the latest generation.
    expect(screen.getByTestId('package-positions-note')).toHaveTextContent(
      'Built from the positions Avery Mbeki could read',
    );
    expect(PKG_PERIOD).toBe(detail.periodEnd);
  });
});
