import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import {
  DEAL_ID,
  DEAL_PATHS,
  dealDetailFixture,
  valuationPageFixture,
} from '../../test/fixtures-deal.js';
import { principalFixture } from '../../test/fixtures.js';
import {
  changeRequestPageFixture,
  changeRequestRowFixture,
  changeRequestRows,
  changeTypeTaxonomyFixture,
  sentPosts,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import { ValuationsTab } from './ValuationsTab.js';

/** The shell registers the taxonomy labels for labelOf; the tests register the change types the same way. */
beforeAll(() =>
  registerTaxonomyLabels(changeTypeTaxonomyFixture().domains.flatMap((d) => d.terms)),
);
afterAll(() => clearTaxonomyLabels());

const REQUESTS = `/api/v1/change-requests?limit=200&investmentId=${DEAL_ID}`;
const TAXONOMY = '/api/v1/taxonomy';
const CREATE = '/api/v1/change-requests';
/** Dropdown journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

vi.mock('@tanstack/react-router', async () => {
  const { routerMock } = await import('../../test/router-mock.js');
  const { DEAL_ID: id } = await import('../../test/fixtures-deal.js');
  return { ...routerMock(), useParams: () => ({ id }) };
});

const EM_DASH = String.fromCharCode(0x2014);

describe('valuations tab', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('charts the Locked versions and lists every version newest first with its reopen reason', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
    });
    renderWithQuery(<ValuationsTab />);

    const card = await screen.findByTestId('deal-valuations');
    expect(card).toHaveTextContent('4 versions, newest first');
    expect(within(card).getByRole('group', { name: 'Locked fair value by period' })).toBeVisible();
    // Only the two Locked versions are plotted, and the summary says so.
    expect(
      within(card).getByText(
        /Locked fair value over 2 periods, from \$25\.1M at December 2024 to \$26\.0M at March 2025\. Only Locked versions are plotted/,
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();

    const table = within(card).getByRole('table', { name: 'Valuation versions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Jun 30, 20251Ops preparedSponsor mark$26.0M$27.4M5.4%-',
      'Mar 31, 20252LockedSponsor mark$25.1M$26.0M3.6%Apr 20, 2025',
      'Mar 31, 20251ReopenedSponsor mark$25.1M$26.8M6.8%Apr 10, 2025',
      'Reopen reason: Sponsor restated the quarter.',
      'Dec 31, 20241LockedSponsor mark-$25.1M-Jan 25, 2025',
    ]);
    // The first version has no prior Locked value: the placeholder, never zero.
    expect(within(rows[4]!).getAllByRole('cell')[4]).toHaveClass('is-missing');
    expect(within(rows[3]!).getByText('Reopen reason: Sponsor restated the quarter.')).toHaveClass(
      'pb-meta',
    );

    expect(within(card).getByRole('link', { name: 'Open the valuation board' })).toHaveAttribute(
      'href',
      '/valuations',
    );
    expect(card).toHaveTextContent(
      'Prepare, approve, lock and reopen live on the valuation board.',
    );
    // Read only: the workflow buttons live on the board.
    expect(screen.queryByRole('button', { name: /lock|approve|prepare|reopen/i })).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(EM_DASH);
  });

  it('says so when the position has no valuation versions', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture([])),
    });
    renderWithQuery(<ValuationsTab />);
    expect(await screen.findByText('No valuation versions')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the valuation board' })).toBeInTheDocument();
  });

  it('falls back to the versions on the position record while the list answers 501', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: failing(501, '/api/v1/valuations'),
    });
    renderWithQuery(<ValuationsTab />);
    expect(
      await screen.findByText('Approvals and prior values are not available yet'),
    ).toBeInTheDocument();
    const recorded = await screen.findByTestId('deal-valuations-recorded');
    expect(recorded).toHaveTextContent('As recorded on the position, newest first');
    const rows = within(within(recorded).getByRole('table', { name: 'Valuation versions' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Jun 30, 20251Ops preparedSponsor mark$27.4M',
      'Mar 31, 20252LockedSponsor mark$26.0M',
      'Mar 31, 20251ReopenedSponsor mark$26.8M',
      'Dec 31, 20241LockedSponsor mark$25.1M',
    ]);
    expect(
      within(recorded).getByRole('group', { name: 'Locked fair value by period' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it("lists the position's change requests with their state and links to the queue", async () => {
    const rows = changeRequestRows().slice(0, 2);
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
      [REQUESTS]: ok(changeRequestPageFixture(rows)),
    });
    renderWithQuery(<ValuationsTab />);
    const card = await screen.findByTestId('deal-change-requests');
    const table = await within(card).findByRole('table', { name: 'Change requests' });
    expect(card).toHaveTextContent('2 requests, newest first');
    const body = within(table).getAllByRole('row').slice(1);
    expect(body.map((r) => r.textContent)).toEqual([
      'Add-on acquisitionMay 15, 2025Add-on acquisition of a regional competitor closed-Submitted-',
      'RecapitalizationApr 30, 2025Dividend recapitalization with a new term loanAvery MbekiRouted-',
    ]);
    expect(within(body[0]!).getByText('Submitted')).toHaveClass('pb-badge-watch');
    expect(
      within(card).getByRole('link', { name: 'Open the change request queue' }),
    ).toHaveAttribute('href', '/valuations/changes');
    // No role: no form (the route admits the deal team and operations).
    expect(screen.queryByTestId('change-request-form')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so when the position has no requests, and when the role may not read them', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
      [REQUESTS]: ok(changeRequestPageFixture([])),
    });
    const first = renderWithQuery(<ValuationsTab />);
    expect(await screen.findByText('No change requests')).toBeInTheDocument();
    first.unmount();
    vi.restoreAllMocks();
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
      [REQUESTS]: failing(403, '/api/v1/change-requests'),
    });
    renderWithQuery(<ValuationsTab />);
    expect(await screen.findByTestId('deal-change-requests-unavailable')).toHaveTextContent(
      'Change requests: not visible to your role',
    );
  });

  it(
    'offers the deal team the request form, refuses what the contract refuses and submits the rest',
    TIMEOUT,
    async () => {
      mockApi({
        [DEAL_PATHS.me]: ok(principalFixture()),
        [DEAL_PATHS.detail]: ok(dealDetailFixture()),
        [DEAL_PATHS.valuations]: ok(valuationPageFixture()),
        [REQUESTS]: ok(changeRequestPageFixture([])),
        [TAXONOMY]: ok(changeTypeTaxonomyFixture()),
        [CREATE]: {
          status: 201,
          body: changeRequestRowFixture({
            investmentId: DEAL_ID,
            summary: 'Add-on acquisition of a regional competitor closed',
          }),
        },
      });
      renderWithQuery(<ValuationsTab />);
      const form = await screen.findByTestId('change-request-form');
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      const submit = within(form).getByRole('button', { name: 'Submit request' });

      // Empty: nothing is sent, the fields say what the contract needs.
      await userEvent.click(submit);
      expect(sentPosts()).toEqual([]);
      expect(within(form).getByText('Choose a change type.')).toBeInTheDocument();
      expect(within(form).getByText('Give the effective date.')).toBeInTheDocument();
      expect(
        within(form).getByText('Summarize the change in 3 to 200 characters of plain text.'),
      ).toBeInTheDocument();
      expect(within(form).getByLabelText(/Summary/)).toHaveAttribute('aria-invalid', 'true');

      await userEvent.click(within(form).getByRole('combobox', { name: /Change type/ }));
      const offered = await screen.findAllByRole('option');
      expect(offered).toHaveLength(9);
      expect(offered[0]).toHaveTextContent('Add-on acquisition');
      await userEvent.click(screen.getByRole('option', { name: 'Add-on acquisition' }));
      fireEvent.change(within(form).getByLabelText(/Effective date/), {
        target: { value: '2025-05-15' },
      });
      await userEvent.click(within(form).getByLabelText(/Summary/));
      await userEvent.paste('Add-on acquisition of a regional competitor closed');
      await userEvent.click(within(form).getByLabelText('Field 1 name'));
      await userEvent.paste('target');
      await userEvent.click(within(form).getByLabelText('Field 1 value'));
      await userEvent.paste('A regional competitor');
      await userEvent.click(within(form).getByRole('button', { name: 'Add field' }));
      expect(within(form).getByLabelText('Field 2 name')).toBeInTheDocument();
      await userEvent.click(within(form).getByRole('button', { name: 'Remove field 2' }));
      expect(within(form).queryByLabelText('Field 2 name')).not.toBeInTheDocument();
      await userEvent.click(submit);
      expect(
        await within(screen.getByRole('status')).findByText(
          'Change request submitted for Meridian Data Partners: Add-on acquisition of a regional competitor closed (audited)',
        ),
      ).toHaveClass('pb-notice-good');
      expect(sentPosts()).toEqual([
        [
          CREATE,
          {
            investmentId: DEAL_ID,
            changeType: 'change_type.add_on_acquisition',
            effectiveDate: '2025-05-15',
            summary: 'Add-on acquisition of a regional competitor closed',
            details: { target: 'A regional competitor' },
          },
        ],
      ]);
      // The form clears for the next request and the session list keeps the result.
      expect(within(form).getByLabelText(/Summary/)).toHaveValue('');
      expect(
        within(screen.getByRole('list', { name: 'Actions this session' })).getByText('Done'),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(EM_DASH);
    },
  );

  it('falls back the same way when the role may not read the list', async () => {
    mockApi({
      [DEAL_PATHS.detail]: ok(dealDetailFixture()),
      [DEAL_PATHS.valuations]: failing(403, '/api/v1/valuations'),
    });
    renderWithQuery(<ValuationsTab />);
    expect(
      await screen.findByText('Valuation versions: not visible to your role'),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('deal-valuations-recorded')).toBeInTheDocument();
  });
});
