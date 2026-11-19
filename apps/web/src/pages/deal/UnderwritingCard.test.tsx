import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { MISSING } from '../../lib/format.js';
import { UnderwritingCard } from './UnderwritingCard.js';
import {
  caseFixture,
  draftFixture,
  loanCaseFixture,
  noFormFixture,
  readFixture,
  reunderwriteFixture,
  UW_ID,
  UW_INVESTMENT,
  UW_PATH,
} from './underwriting.fixtures.js';

vi.mock('@tanstack/react-router', async () => {
  const base = (await import('../../test/router-mock.js')).routerMock();
  return {
    ...base,
    // The source link addresses the document hub by href (HubLink).
    Link: (props: { href?: string; 'data-testid'?: string; children?: ReactNode }) => (
      <a href={props.href} data-testid={props['data-testid']}>
        {props.children}
      </a>
    ),
  };
});

/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

const show = (): void => {
  renderWithQuery(<UnderwritingCard id={UW_INVESTMENT} company="Saltmarsh Holdings" />);
};
const card = (): HTMLElement => screen.getByTestId('deal-underwriting');
const tile = (name: string): HTMLElement =>
  within(screen.getByTestId('deal-underwriting-tiles')).getByRole('group', { name });
const rowsOf = (table: HTMLElement): (string | null)[] =>
  within(table)
    .getAllByRole('row')
    .map((r) => r.textContent);

describe('deal workspace: the position against the base case', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leads with EBITDA, revenue and net debt against plan, then our IRR and MOIC, each with its status', async () => {
    mockApi({ [UW_PATH]: ok(readFixture()) });
    show();
    await screen.findByTestId('deal-underwriting-tiles');
    expect(card()).toHaveTextContent("Against the sponsor's base case");
    expect(card()).toHaveTextContent('Quarter ended Jun 30, 2023');
    expect(tile('EBITDA against plan')).toHaveTextContent(
      '-7.1%Behind plan$65.0M against a plan of $70.0M',
    );
    expect(tile('Revenue against plan')).toHaveTextContent(
      '+6.7%Ahead of plan$320.0M against a plan of $300.0M',
    );
    expect(tile('Net debt against plan')).toHaveTextContent(
      '+1.7%On plan$120.0M against a plan of $118.0M',
    );
    expect(tile('Gross IRR against plan')).toHaveTextContent(
      '-6.0 pointsBehind plan14.0% against 20.0% underwritten',
    );
    // The MOIC carries no badge: it is set against the path and the exit target, not judged.
    expect(tile('Gross MOIC')).toHaveTextContent(
      '1.30x-0.14x against 1.44x on the underwritten path; 2.50x at exit',
    );
    expect(tile('Gross MOIC')).not.toHaveTextContent(/plan$/);
    // EBITDA is the headline: the first tile.
    const groups = within(screen.getByTestId('deal-underwriting-tiles')).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'EBITDA against plan',
      'Revenue against plan',
      'Net debt against plan',
      'Gross IRR against plan',
      'Gross MOIC',
    ]);
  });

  it('charts actual against plan for one metric, EBITDA first, with a table twin and the straight-line note', async () => {
    mockApi({ [UW_PATH]: ok(readFixture()) });
    show();
    const figure = await screen.findByTestId('deal-underwriting-chart');
    expect(
      within(figure).getByRole('group', { name: 'EBITDA, actual and plan' }),
    ).toBeInTheDocument();
    expect(
      within(within(figure).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Actual', 'Plan']);
    await userEvent.click(within(figure).getByRole('button', { name: 'Show table' }));
    expect(
      rowsOf(within(figure).getByRole('table', { name: 'EBITDA, actual and plan, as a table' })),
    ).toEqual([
      'PeriodActualPlan',
      // No approved quarter on a plan date, and no approved EBITDA in March: gaps, never zeros.
      'Jun 2021-$40.0M',
      'Dec 2022$60.0M$66.4M',
      'Mar 2023-$68.2M',
      'Jun 2023$65.0M$70.0M',
      'Dec 2023-$73.7M',
      'Jun 2026-$80.0M',
    ]);
    expect(card()).toHaveTextContent(
      'Between plan dates the plan is a straight line, not a sponsor figure.',
    );
    // The picker moves the chart to another metric.
    await userEvent.click(screen.getByRole('combobox', { name: 'Metric' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Net debt' }, TIMEOUT));
    const netDebt = await within(screen.getByTestId('deal-underwriting-chart')).findByRole(
      'table',
      { name: 'Net debt, actual and plan, as a table' },
      TIMEOUT,
    );
    expect(rowsOf(netDebt)[4]).toBe('Jun 2023$120.0M$118.0M');
  });

  it('sets the value creation earned against the planned bridge, with the time that has passed', async () => {
    mockApi({ [UW_PATH]: ok(readFixture()) });
    show();
    const table = await screen.findByRole('table', { name: 'Value creation against plan' });
    expect(rowsOf(table)).toEqual([
      'DriverPlanned to exitEarned to dateProgress',
      'EBITDA growth+$400.0M+$250.0M62.5%',
      'Multiple expansion+$80.0M+$65.0M81.3%',
      'Debt paydown+$50.0M+$30.0M60.0%',
      'Total+$530.0M+$345.0M65.1%',
    ]);
    expect(screen.getByTestId('deal-underwriting-drivers')).toHaveTextContent(
      '40% of the planned time has passed.',
    );
  });

  it('shows the case compared: its terms, who entered and confirmed it, its source and its plan', async () => {
    mockApi({ [UW_PATH]: ok(readFixture()) });
    show();
    const block = await screen.findByTestId('deal-underwriting-case');
    expect(within(block).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Entry caseConfirmed',
    );
    expect(rowsOf(within(block).getByRole('table', { name: 'Entry case, terms' }))).toEqual([
      'Case dateJun 30, 2021',
      'Planned exitJun 30, 2026',
      'Exit multiple11.0x',
      'Underwritten gross MOIC2.50x',
      'Underwritten gross IRR20.0%',
      'Entered byBlake Okafor, Jul 6, 2021',
      'Confirmed byFinley Castellano, Jul 8, 2021',
      'SourceSponsor base case model at entry, held in the deal folder',
    ]);
    expect(rowsOf(within(block).getByRole('table', { name: 'Entry case, plan' }))).toEqual([
      'Twelve months endingRevenueEBITDANet debt',
      'Jun 30, 2021$200.0M$40.0M$150.0M',
      'Dec 31, 2022$281.9M$66.4M$121.6M',
      'Dec 31, 2023$318.4M$73.7M$114.3M',
      'Jun 30, 2026$400.0M$80.0M$100.0M',
    ]);
    // One version, shown in full: no list of versions and nothing to pick.
    expect(screen.queryByTestId('deal-underwriting-versions')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Compared with' })).not.toBeInTheDocument();
  });

  it('compares with the entry case until the reader picks a later version, and links its source document', async () => {
    const versions = [caseFixture(), reunderwriteFixture()];
    mockApi({
      [UW_PATH]: ok(readFixture({ versions })),
      [`${UW_PATH}?version=2`]: ok(readFixture({ versions, compared: 2 })),
    });
    show();
    const picker = await screen.findByRole('combobox', { name: 'Compared with' });
    expect(picker).toHaveTextContent('Entry case');
    expect(rowsOf(screen.getByRole('table', { name: 'Versions of the base case' }))).toEqual([
      'VersionCaseStateCase dateEntered byConfirmed byReason',
      `1Entry caseConfirmedJun 30, 2021Blake Okafor, Jul 6, 2021Finley Castellano, Jul 8, 2021${MISSING}`,
      '2Re-underwritten Mar 31, 2023ConfirmedMar 31, 2023Blake Okafor, Apr 10, 2023Finley Castellano, Apr 12, 2023Sponsor re-underwrote after the 2022 acquisition',
    ]);
    await userEvent.click(picker);
    await userEvent.click(
      await screen.findByRole('option', { name: 'Re-underwritten Mar 31, 2023' }, TIMEOUT),
    );
    const block = await screen.findByRole(
      'table',
      { name: 'Re-underwritten Mar 31, 2023, terms' },
      TIMEOUT,
    );
    expect(block).toHaveTextContent('Exit multiple10.0x');
    expect(block).toHaveTextContent('Reason for the revisionSponsor re-underwrote after the 2022');
    expect(screen.getByTestId('underwriting-source')).toHaveAttribute(
      'href',
      `/documents/${UW_ID.document}`,
    );
    expect(block).toHaveTextContent(
      'SourceSaltmarsh Holdings sponsor model 2023, page 12, Base case!B14',
    );
    // The gap is now to the later plan: 17% underwritten.
    expect(tile('Gross IRR against plan')).toHaveTextContent('14.0% against 17.0% underwritten');
    expect(
      sentRequests()
        .map(([url]) => url)
        .filter((url) => url.includes('/underwriting')),
    ).toEqual([UW_PATH, `${UW_PATH}?version=2`]);
  });

  it('says so when no base case is recorded, and shows a draft as a draft, never compared', async () => {
    mockApi({ [UW_PATH]: ok(readFixture({ versions: [] })) });
    show();
    const empty = await screen.findByTestId('deal-underwriting-empty');
    expect(empty).toHaveTextContent('No base case recorded.');
    expect(card()).toHaveTextContent('As of Jun 30, 2023');
    expect(screen.queryByTestId('deal-underwriting-tiles')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockApi({ [UW_PATH]: ok(readFixture({ versions: [draftFixture()], compared: null })) });
    show();
    expect(await screen.findByTestId('deal-underwriting-empty')).toHaveTextContent(
      'A draft base case waits for a second person to confirm it.',
    );
    const draft = screen.getByTestId('deal-underwriting-draft');
    expect(within(draft).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Draft base caseDraft',
    );
    expect(within(draft).getByRole('table', { name: 'Draft base case, terms' })).toHaveTextContent(
      `Confirmed by${MISSING}`,
    );
    expect(screen.queryByTestId('deal-underwriting-tiles')).not.toBeInTheDocument();
  });

  it('keeps a withdrawn case in the list of versions when none stands', async () => {
    const retired = caseFixture({
      state: 'Withdrawn',
      withdrawnReason: 'Confirmed against the wrong model',
    });
    mockApi({ [UW_PATH]: ok(readFixture({ versions: [retired], compared: null })) });
    show();
    expect(await screen.findByTestId('deal-underwriting-empty')).toHaveTextContent(
      'No base case stands: what was recorded has been withdrawn.',
    );
    expect(screen.getByRole('table', { name: 'Versions of the base case' })).toHaveTextContent(
      'WithdrawnJun 30, 2021Blake Okafor, Jul 6, 2021Finley Castellano, Jul 8, 2021Confirmed against the wrong model',
    );
  });

  it('shows the missing placeholder with its reason for every figure that is not calculable', async () => {
    mockApi({
      [UW_PATH]: ok(
        readFixture({
          inputs: {
            current: null,
            quarters: [],
            bridge: null,
            bridgeNotCalculable: 'no_current_quarter',
            grossIrr: null,
            grossMoic: null,
            irrFlag: 'no_valuation',
          },
        }),
      ),
    });
    show();
    await screen.findByTestId('deal-underwriting-tiles');
    for (const name of ['EBITDA against plan', 'Revenue against plan', 'Net debt against plan'])
      expect(tile(name)).toHaveTextContent(`${MISSING}No approved quarter to compare.`);
    expect(tile('Gross IRR against plan')).toHaveTextContent(`${MISSING}No locked valuation yet.`);
    // The MOIC is missing for the reason the IRR is, and its tile says so before the path.
    expect(tile('Gross MOIC')).toHaveTextContent(
      `${MISSING}No locked valuation yet. 1.44x on the underwritten path; 2.50x at exit`,
    );
    expect(card()).toHaveTextContent('As of Jun 30, 2023');
    const drivers = screen.getByTestId('deal-underwriting-drivers');
    expect(drivers).toHaveTextContent(`EBITDA growth+$400.0M${MISSING}${MISSING}`);
    expect(drivers).toHaveTextContent(
      'Progress is not calculable: No approved quarter to compare.',
    );
    // The plan itself is still charted: its dates need no quarter.
    expect(screen.getByTestId('deal-underwriting-chart')).toBeInTheDocument();
    // No figure that could not be worked out reads as a zero.
    expect(card()).not.toHaveTextContent(/(?<![\d.])0\.0+[%x]/);
  });

  it('judges a loan on its IRR alone: the IRR and the MOIC, then its yields with no status, no chart and no drivers', async () => {
    mockApi({ [UW_PATH]: ok(readFixture({ form: 'credit' })) });
    show();
    await screen.findByTestId('deal-underwriting-tiles');
    // No company quarter is compared, so the card is dated by its as-of date.
    expect(card()).toHaveTextContent('As of Jun 30, 2023');
    const groups = within(screen.getByTestId('deal-underwriting-tiles')).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Gross IRR against plan',
      'Gross MOIC',
      'Yield to maturity',
      'Underwritten yield',
      'Underwritten loss rate',
    ]);
    expect(tile('Gross IRR against plan')).toHaveTextContent(
      '-4.9 pointsBehind plan5.1% against 10.0% underwritten',
    );
    // A loan reaches its underwritten MOIC at repayment, and the MOIC is not judged.
    expect(tile('Gross MOIC')).toHaveTextContent(
      '1.10x-0.10x against 1.20x on the underwritten path; 1.50x at repayment',
    );
    // Yields show two decimals, and none of the three carries a status.
    expect(tile('Yield to maturity')).toHaveTextContent(
      'Yield to maturity14.37%On the fair value of the latest approved credit quarter',
    );
    expect(tile('Underwritten yield')).toHaveTextContent(
      'Underwritten yield11.50%Annual yield, as underwritten at entry',
    );
    expect(tile('Underwritten loss rate')).toHaveTextContent(
      'Underwritten loss rate1.50%Expected loss a year',
    );
    const badges = groups.map((g) => g.querySelectorAll('.pb-badge').length);
    expect(badges).toEqual([1, 0, 0, 0, 0]);
    expect(screen.getByTestId('deal-underwriting-yield-note')).toHaveTextContent(
      'Yield to maturity is priced on the fair value of the latest approved credit quarter, which our own mark does not change. It rises when that fair value falls, so it is not judged.',
    );
    // A loan has no company plan: nothing is charted and no driver is set against one.
    expect(screen.queryByTestId('deal-underwriting-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deal-underwriting-drivers')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Metric' })).not.toBeInTheDocument();
    expect(card()).not.toHaveTextContent('Between plan dates');

    // Its case: the expected repayment, the yield and the loss rate, no exit multiple, no plan.
    const block = screen.getByTestId('deal-underwriting-case');
    expect(rowsOf(within(block).getByRole('table', { name: 'Entry case, terms' }))).toEqual([
      'Case dateJun 30, 2021Expected repaymentJun 30, 2026',
      'Underwritten yield11.50%Annual loss rate1.50%',
      'Underwritten gross MOIC1.50xUnderwritten gross IRR10.0%',
      'Entered byBlake Okafor, Jul 6, 2021Confirmed byFinley Castellano, Jul 8, 2021',
      'SourceUnderwriting model of the loan at entry, held in the deal folder',
    ]);
    expect(block).not.toHaveTextContent('Exit multiple');
    expect(block).not.toHaveTextContent('Planned exit');
    expect(
      within(block).queryByRole('table', { name: 'Entry case, plan' }),
    ).not.toBeInTheDocument();
  });

  it('shows a loan with no yield to maturity and no underwritten loss rate as missing, with the reason, never a zero', async () => {
    mockApi({
      [UW_PATH]: ok(
        readFixture({
          form: 'credit',
          versions: [loanCaseFixture({ annualLossRate: null, plannedExitDate: '2023-03-31' })],
          inputs: { yieldToMaturity: null },
        }),
      ),
    });
    show();
    await screen.findByTestId('deal-underwriting-tiles');
    expect(tile('Yield to maturity')).toHaveTextContent(
      `Yield to maturity${MISSING}Not calculable this quarter.`,
    );
    expect(tile('Underwritten loss rate')).toHaveTextContent(
      `Underwritten loss rate${MISSING}None was underwritten.`,
    );
    // Past the expected repayment there is no path to set the MOIC against.
    expect(tile('Gross MOIC')).toHaveTextContent(
      '1.10xNo figure on the underwritten path: After the plan ends. Underwritten 1.50x at repayment.',
    );
    expect(screen.getByRole('table', { name: 'Entry case, terms' })).toHaveTextContent(
      `Annual loss rate${MISSING}`,
    );
    expect(card()).not.toHaveTextContent(/(?<![\d.])0\.0+[%x]/);
  });

  it('shows nothing for a position that holds no base case, or one the reader cannot see', async () => {
    mockApi({ [UW_PATH]: ok(noFormFixture()) });
    show();
    await waitFor(() =>
      expect(screen.queryByTestId('deal-underwriting-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('deal-underwriting')).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockApi({ [UW_PATH]: failing(404, UW_PATH) });
    show();
    await waitFor(() =>
      expect(screen.queryByTestId('deal-underwriting-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('deal-underwriting')).not.toBeInTheDocument();
  });

  it('degrades to a notice when the read fails, and says when it is not available in this build', async () => {
    mockApi({ [UW_PATH]: { status: 500, body: { title: 'Server error', status: 500 } } });
    show();
    expect(await screen.findByTestId('deal-underwriting')).toHaveTextContent(
      'The base case could not load',
    );
    cleanup();
    vi.restoreAllMocks();

    mockApi({ [UW_PATH]: failing(501, UW_PATH) });
    show();
    expect(await screen.findByTestId('deal-underwriting')).toHaveTextContent(
      'The base case: not available yet',
    );
  });

  it('offers the entry case again when a picked version is no longer compared', async () => {
    const versions = [caseFixture(), reunderwriteFixture()];
    mockApi({
      [UW_PATH]: ok(readFixture({ versions })),
      [`${UW_PATH}?version=2`]: failing(404, UW_PATH),
    });
    show();
    await userEvent.click(await screen.findByRole('combobox', { name: 'Compared with' }));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Re-underwritten Mar 31, 2023' }, TIMEOUT),
    );
    expect(
      await screen.findByText(/no longer one the position is compared with/, {}, TIMEOUT),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show the entry case' }));
    expect(await screen.findByTestId('deal-underwriting-tiles')).toBeInTheDocument();
  });
});
