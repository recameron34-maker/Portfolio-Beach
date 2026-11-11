import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import { renderWithQuery } from '../../test/render.js';
import { MISSING } from '../../lib/format.js';
import {
  dune,
  investmentValueCreationFixture,
  kelp,
  saltmarsh,
  tidepool,
  VC_ID,
} from '../analytics/value-creation.fixtures.js';
import { ValueCreationCard } from './ValueCreationCard.js';

vi.mock('@tanstack/react-router', async () =>
  (await import('../../test/router-mock.js')).routerMock(),
);

const pathOf = (id: string): string => `/api/v1/investments/${id}/value-creation`;
const PATH = pathOf(VC_ID.saltmarsh);

const card = (): HTMLElement => screen.getByTestId('deal-value-creation');
const rowOf = (table: HTMLElement, text: string): HTMLElement => {
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
};

describe('deal workspace: value creation card', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leads with the change in equity value and its three drivers, each with its share', async () => {
    mockApi({ [PATH]: ok(investmentValueCreationFixture()) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    const tiles = await screen.findByTestId('deal-value-creation-tiles');
    const tile = (name: string): HTMLElement => within(tiles).getByRole('group', { name });
    expect(tile('Equity value change')).toHaveTextContent('+$345.0M');
    expect(tile('Equity value change')).toHaveTextContent('$250.0M at entry to $595.0M now');
    expect(tile('EBITDA growth')).toHaveTextContent('+$250.0M72.5% of the change');
    expect(tile('Multiple expansion')).toHaveTextContent('+$65.0M18.8% of the change');
    expect(tile('Debt paydown')).toHaveTextContent('+$30.0M8.7% of the change');
    expect(card()).toHaveTextContent('Entry snapshot Dec 31, 2018 to Jun 30, 2025');
    // The headline comes before the charts and the table.
    const groups = within(card())
      .getAllByRole('group')
      .filter((g) => g.getAttribute('aria-label') !== null);
    expect(groups[0]).toBe(tile('Equity value change'));
  });

  it('draws the company bridge from entry to now, opens EBITDA growth on request and has a table twin', async () => {
    mockApi({ [PATH]: ok(investmentValueCreationFixture()) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    const bridge = await screen.findByRole('group', { name: 'Value creation bridge' });
    for (const name of [
      'Equity value at entry: $250.0M',
      'EBITDA growth: +$250.0M',
      'Multiple expansion: +$65.0M',
      'Debt paydown: +$30.0M',
      'Equity value now: $595.0M',
    ])
      expect(within(bridge).getByRole('img', { name })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('switch', {
        name: 'Open EBITDA growth into revenue growth and margin change',
      }),
    );
    expect(
      within(bridge).getByRole('img', { name: 'Revenue growth: +$120.0M' }),
    ).toBeInTheDocument();
    expect(
      within(bridge).getByRole('img', { name: 'Margin change: +$130.0M' }),
    ).toBeInTheDocument();
    const figure = screen.getByTestId('deal-value-creation-bridge');
    await userEvent.click(within(figure).getByRole('button', { name: 'Show table' }));
    expect(
      within(figure).getByRole('table', { name: 'Value creation bridge, as a table' }),
    ).toHaveTextContent('Equity value now$595.0M');
    // Our own gain on the position, split by the company's shares, in one sentence.
    expect(screen.getByTestId('deal-value-creation-ours')).toHaveTextContent(
      'Our gain on this position is $6.9M: +$5.0M from EBITDA growth, +$1.3M from multiple expansion and +$0.6M from debt paydown, split by the company shares above.',
    );
  });

  it('charts the indexed lines by quarter, with a gap where a figure is missing', async () => {
    mockApi({ [PATH]: ok(investmentValueCreationFixture()) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    const figure = await screen.findByTestId('deal-value-creation-index');
    expect(within(figure).getByRole('group', { name: 'Indexed since entry' })).toBeInTheDocument();
    expect(
      within(within(figure).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['EBITDA', 'EV', 'Equity value', 'Our mark']);
    await userEvent.click(within(figure).getByRole('button', { name: 'Show table' }));
    const table = within(figure).getByRole('table', { name: 'Indexed since entry, as a table' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual([
      'PeriodEBITDAEVEquity valueOur mark',
      // Our mark has no figure on the entry snapshot, and EBITDA none in March: gaps, never zeros.
      'Entry100.0100.0100.0-',
      'Dec 2024150.0160.0200.0140.0',
      'Mar 2025-170.0220.0145.0',
      'Jun 2025162.5178.8238.0149.0',
    ]);
  });

  it('sets entry against current metrics, with the change since entry', async () => {
    mockApi({ [PATH]: ok(investmentValueCreationFixture()) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    const table = await screen.findByRole('table', { name: 'Entry against current' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Metric', 'Entry, Dec 31, 2018', 'Current, Jun 30, 2025', 'Change since entry']);
    expect(rowOf(table, 'EBITDA, LTM')).toHaveTextContent('EBITDA, LTM$40.0M$65.0M62.5%');
    expect(rowOf(table, 'Enterprise value')).toHaveTextContent('$400.0M$715.0M78.8%');
    expect(rowOf(table, 'Net debt')).toHaveTextContent('Net debt$150.0M$120.0M-$30.0M');
    expect(rowOf(table, 'Equity value')).toHaveTextContent('$250.0M$595.0M138.0%');
    expect(rowOf(table, 'EV / EBITDA')).toHaveTextContent('EV / EBITDA10.0x11.0x+1.0x');
    expect(rowOf(table, 'Net debt / EBITDA')).toHaveTextContent('3.8x1.8x-1.9x');
  });

  it('shows a contracting multiple as a negative step and a falling margin when opened', async () => {
    mockApi({
      [pathOf(VC_ID.kelp)]: ok(
        investmentValueCreationFixture({ investmentId: VC_ID.kelp, position: kelp() }),
      ),
    });
    renderWithQuery(<ValueCreationCard id={VC_ID.kelp} company="Kelp Forest Foods" />);
    const bridge = await screen.findByRole('group', { name: 'Value creation bridge' });
    expect(
      within(bridge).getByRole('img', { name: 'Multiple expansion: -$35.0M' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch'));
    expect(within(bridge).getByRole('img', { name: 'Margin change: -$72.0M' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('deal-value-creation-tiles')).getByRole('group', {
        name: 'Multiple expansion',
      }),
    ).toHaveTextContent('-$35.0M-36.8% of the change');
  });

  it('shows the placeholder with the reason when the bridge is not calculable, never zeros', async () => {
    mockApi({
      [pathOf(VC_ID.tidepool)]: ok(
        investmentValueCreationFixture({
          investmentId: VC_ID.tidepool,
          position: tidepool(),
          series: [
            {
              periodEnd: '2025-03-31',
              isEntry: false,
              ebitdaIndex: null,
              evIndex: null,
              equityValueIndex: null,
              markIndex: '115',
            },
            {
              periodEnd: '2025-06-30',
              isEntry: false,
              ebitdaIndex: null,
              evIndex: null,
              equityValueIndex: null,
              markIndex: '120',
            },
          ],
        }),
      ),
    });
    renderWithQuery(<ValueCreationCard id={VC_ID.tidepool} company="Tidepool Analytics" />);
    expect(
      await screen.findByText('The value creation bridge is not calculable'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No approved entry snapshot on or before the as-of date.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Value creation bridge' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('deal-value-creation-tiles')).not.toBeInTheDocument();
    // What is on record still shows: the current quarter and our mark per 100 invested.
    const table = screen.getByRole('table', { name: 'Entry against current' });
    expect(rowOf(table, 'EBITDA, LTM')).toHaveTextContent(`EBITDA, LTM${MISSING}$65.0M${MISSING}`);
    expect(rowOf(table, 'Equity value')).toHaveTextContent(
      `Equity value${MISSING}$595.0M${MISSING}`,
    );
    expect(card()).not.toHaveTextContent('$0.0M');
    expect(screen.getByRole('group', { name: 'Indexed since entry' })).toBeInTheDocument();
    expect(screen.getByTestId('deal-value-creation-ours')).toHaveTextContent(
      'Our gain on this position is $1.0M. It is not split by driver: No approved entry snapshot on or before the as-of date.',
    );
  });

  it('names EBITDA at or below zero as the reason and keeps the growth figures that exist', async () => {
    mockApi({
      [pathOf(VC_ID.dune)]: ok(
        investmentValueCreationFixture({ investmentId: VC_ID.dune, position: dune(), series: [] }),
      ),
    });
    renderWithQuery(<ValueCreationCard id={VC_ID.dune} company="Dune Grass Logistics" />);
    expect(
      await screen.findByText('EBITDA is at or below zero at entry or in the current quarter.'),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Entry against current' });
    expect(rowOf(table, 'EBITDA, LTM')).toHaveTextContent('$20.0M-$5.0M-125.0%');
    expect(rowOf(table, 'EV / EBITDA')).toHaveTextContent(`12.5x${MISSING}${MISSING}`);
    expect(rowOf(table, 'Net debt')).toHaveTextContent('$130.0M$140.0M+$10.0M');
    // The equity value is on record at both ends although there is no bridge between them.
    expect(rowOf(table, 'Equity value')).toHaveTextContent('$120.0M$40.0M-66.7%');
    // No quarter to chart: said plainly, not drawn as a flat line.
    expect(screen.getByText('No approved quarter to chart')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Indexed since entry' })).not.toBeInTheDocument();
  });

  it('says the company equity value did not change instead of dividing by zero', async () => {
    const flat = saltmarsh({
      bridge: {
        ...saltmarsh().bridge!,
        equityCurrent: '250000000',
        ebitdaGrowth: '50000000',
        multipleExpansion: '-30000000',
        debtPaydown: '-20000000',
        total: '0',
        shares: null,
      },
      gainByDriver: null,
      gainNotCalculable: 'no_equity_change',
    });
    mockApi({ [PATH]: ok(investmentValueCreationFixture({ position: flat })) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    const tiles = await screen.findByTestId('deal-value-creation-tiles');
    expect(within(tiles).getByRole('group', { name: 'Equity value change' })).toHaveTextContent(
      '$0.0M',
    );
    expect(within(tiles).getByRole('group', { name: 'EBITDA growth' })).toHaveTextContent(
      '+$50.0MNo share: the total is zero',
    );
    expect(screen.getByTestId('deal-value-creation-ours')).toHaveTextContent(
      'It is not split by driver: The company equity value did not change, so there are no shares to split by.',
    );
  });

  it('shows nothing for a credit or fund position, and nothing for a position that is not found', async () => {
    mockApi({
      [pathOf(VC_ID.credit)]: ok(
        investmentValueCreationFixture({
          investmentId: VC_ID.credit,
          dealType: 'deal_type.private_credit',
          position: null,
          series: [],
        }),
      ),
    });
    const { container } = renderWithQuery(
      <ValueCreationCard id={VC_ID.credit} company="Summit Services Co" />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(screen.queryByTestId('deal-value-creation')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    cleanup();
    vi.restoreAllMocks();
    mockApi({});
    const missing = renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="X" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await waitFor(() => expect(missing.container.querySelector('[aria-busy]')).toBeNull());
    expect(missing.container).toBeEmptyDOMElement();
  });

  it('degrades a 501 to the not-built wording and shows any other failure in the card', async () => {
    mockApi({ [PATH]: failing(501, PATH) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    expect(await screen.findByText('Value creation: not available yet')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
    mockApi({ [PATH]: failing(403, PATH) });
    renderWithQuery(<ValueCreationCard id={VC_ID.saltmarsh} company="Saltmarsh Holdings" />);
    expect(await screen.findByText('Value creation: not visible to your role')).toBeInTheDocument();
  });
});
