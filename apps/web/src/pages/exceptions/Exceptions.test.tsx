import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import { EXCEPTION_ID, exceptionPageFixture, exceptions } from '../../test/fixtures-exceptions.js';
import { FILE_ID } from '../../test/fixtures-intake.js';
import { RUN_ID } from '../../test/fixtures-lookthrough.js';
import { POSITION_ID, sentRequests } from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ExceptionsPage } from './Exceptions.js';

const route = vi.hoisted(() => {
  const search: { file?: string; state?: string; source?: string; severity?: string } = {};
  return { search };
});

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useSearch: () => route.search,
}));

const LIST = '/api/v1/data-exceptions';
/** Dialog and dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

/** The queue as the API filters it: every parameter the page sends narrows the fixture. */
function filtered(): MockRoutes[string] {
  return (url: URL) => {
    const state = url.searchParams.get('state');
    const source = url.searchParams.get('source');
    const severity = url.searchParams.get('severity');
    return ok(
      exceptionPageFixture(
        exceptions().filter(
          (x) =>
            (state === null || x.state === state) &&
            (source === null || x.source === source) &&
            (severity === null || x.severity === severity),
        ),
      ),
    );
  };
}

function routes(overrides: MockRoutes = {}): MockRoutes {
  route.search = {};
  return { [LIST]: filtered(), ...overrides };
}

const rowOf = (text: string): HTMLElement => {
  const table = screen.getByRole('table', { name: 'Data exceptions' });
  const row = within(table).getByText(text).closest('tr');
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
};

const rows = (): HTMLElement[] =>
  within(screen.getByRole('table', { name: 'Data exceptions' }))
    .getAllByRole('row')
    .slice(1);

async function pick(combobox: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: combobox }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('the exceptions queue', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every exception with its rule, source, context, texts, severity, state, owner, ticket and age', async () => {
    mockApi(routes());
    renderWithQuery(<ExceptionsPage />);
    const table = await screen.findByRole('table', { name: 'Data exceptions' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Exceptions');
    expect(screen.getByTestId('exceptions-table')).toBe(table);
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(screen.getByText('6 of 6 exceptions')).toBeInTheDocument();
    expect(sentRequests().map(([url]) => url)).toEqual([`${LIST}?limit=200`]);

    const nav = rowOf('21500000.00');
    expect(within(nav).getByRole('link', { name: 'LT-TIE-01' })).toHaveAttribute(
      'href',
      `/data/exceptions/${EXCEPTION_ID.nav}`,
    );
    expect(within(nav).getByText('Look-through reconcile')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'lookthrough-2025-06-30.json' })).toHaveAttribute(
      'href',
      `/data/lookthrough/${RUN_ID.defects}`,
    );
    expect(within(nav).getByText('Row 2')).toHaveClass('pb-key');
    expect(
      within(nav).getByRole('link', { name: 'INV-0004 Silverline Staffing Holdings' }),
    ).toHaveAttribute('href', `/portfolio/${POSITION_ID.silverline}`);
    expect(within(nav).getByText('20000000.00')).toBeInTheDocument();
    expect(within(nav).getByText('High')).toHaveClass('pb-badge-bad');
    expect(within(nav).getByText('Open')).toHaveClass('pb-badge-watch');
    expect(within(nav).getAllByText('-')).toHaveLength(2);
    expect(within(nav).getAllByRole('cell')[9]).toHaveTextContent(/^(today|\d+ days?)$/);

    const unmatched = rowOf('Meridian Data Partner');
    expect(within(unmatched).getByText('Row 5')).toBeInTheDocument();
    expect(within(unmatched).queryByRole('link', { name: /INV-/ })).not.toBeInTheDocument();
    expect(within(unmatched).getByText('a position on record')).toBeInTheDocument();

    const accounting = rowOf('Summit Services Company');
    expect(within(accounting).getByText('Accounting import')).toBeInTheDocument();
    expect(
      within(accounting).getByRole('link', { name: 'accounting-export-2025-06-30-update.csv' }),
    ).toHaveAttribute('href', `/data/intake/${FILE_ID.update}`);
    expect(within(accounting).getByText('Acknowledged')).toHaveClass('pb-badge-brand');
    expect(within(accounting).getByText('Avery Castellanos')).toBeInTheDocument();
    expect(within(accounting).getByText('HD-1042')).toBeInTheDocument();

    const resolved = rowOf('TIE-01');
    expect(within(resolved).getByText('Resolved')).toHaveClass('pb-badge-good');
    expect(within(resolved).getByText('High')).toHaveClass('pb-badge-bad');
    expect(within(rowOf('Other')).getByText('Medium')).toHaveClass('pb-badge-watch');
    expect(screen.queryByTestId('exceptions-file-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exceptions-truncated')).not.toBeInTheDocument();
  });

  it('sends the state, source and severity filters to the API', TIMEOUT, async () => {
    mockApi(routes());
    renderWithQuery(<ExceptionsPage />);
    await screen.findByRole('table', { name: 'Data exceptions' });
    await pick('State', 'Open');
    await waitFor(() => expect(rows()).toHaveLength(4));
    await pick('Severity', 'High');
    await waitFor(() => expect(rows()).toHaveLength(2));
    await pick('Source', 'Accounting import');
    await waitFor(() => expect(screen.getByTestId('exceptions-empty')).toBeInTheDocument());
    expect(
      screen.getByText('Clear a filter, or pick another state, source or severity.'),
    ).toBeInTheDocument();
    await pick('State', 'All states');
    await waitFor(() => expect(rows()).toHaveLength(2));
    const urls = sentRequests().map(([url]) => url);
    expect(urls).toContain(`${LIST}?limit=200&state=open`);
    expect(urls).toContain(`${LIST}?limit=200&severity=exception_severity.high&state=open`);
    expect(urls).toContain(
      `${LIST}?limit=200&severity=exception_severity.high&source=accounting_import&state=open`,
    );
    expect(urls).toContain(
      `${LIST}?limit=200&severity=exception_severity.high&source=accounting_import`,
    );
  });

  it('starts from the filters in the address, and shows one run’s exceptions when opened from it', async () => {
    mockApi(routes());
    route.search = { state: 'open', file: RUN_ID.defects };
    renderWithQuery(<ExceptionsPage />);
    await screen.findByRole('table', { name: 'Data exceptions' });
    expect(sentRequests().map(([url]) => url)).toEqual([`${LIST}?limit=200&state=open`]);
    expect(rows()).toHaveLength(4);
    expect(screen.getByText('4 of 4 exceptions')).toBeInTheDocument();
    const note = screen.getByTestId('exceptions-file-note');
    expect(note).toHaveTextContent('Showing the exceptions of lookthrough-2025-06-30.json.');
    expect(within(note).getByRole('link', { name: 'Show every exception' })).toHaveAttribute(
      'href',
      '/data/exceptions',
    );
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveTextContent('Open');
  });

  it('says when nothing is waiting, and when only the first page is shown', async () => {
    mockApi(routes({ [LIST]: ok(exceptionPageFixture([])) }));
    renderWithQuery(<ExceptionsPage />);
    expect(await screen.findByText('No exceptions match')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is waiting for a person/)).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes({ [LIST]: ok(exceptionPageFixture(undefined, 'next')) }));
    renderWithQuery(<ExceptionsPage />);
    expect(await screen.findByTestId('exceptions-truncated')).toHaveTextContent(
      'Showing the first 200 exceptions; more exist.',
    );
  });

  it('tells a viewer who the queue is for, and degrades while the endpoint answers 501', async () => {
    mockApi(routes({ [LIST]: failing(403, LIST) }));
    renderWithQuery(<ExceptionsPage />);
    expect(
      await screen.findByText('Exceptions are for operations and reviewers'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('exceptions-unavailable')).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    mockApi(routes({ [LIST]: failing(501, LIST) }));
    renderWithQuery(<ExceptionsPage />);
    expect(await screen.findByText('Exceptions: not available yet')).toBeInTheDocument();
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<ExceptionsPage />);
    await screen.findByRole('table', { name: 'Data exceptions' });
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
