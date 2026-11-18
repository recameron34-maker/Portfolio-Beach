import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { ReportPackageDetail } from '@pb/contracts';
import { failing, mockApi, ok } from '../../../test/api-mock.js';
import {
  generatedDetailFixture,
  packageDetailFixture,
  PKG_ID,
  PKG_PERSON,
} from '../../../test/fixtures-packages.js';
import { renderWithQuery } from '../../../test/render.js';
import { PackageDetailPage } from './PackageDetail.js';
import { NET_NOTICE, NEXT_STEP_WORDS } from './packages.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const detailPath = (id: string): string => `/api/v1/report-packages/${id}`;

/** An identifier a page must never show: a rule code, or a uuid. */
const IDENTIFIER = /QA-[A-Z]+-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function open(detail: ReportPackageDetail): void {
  params.id = detail.id;
  mockApi({ [detailPath(detail.id)]: ok(detail) });
  renderWithQuery(<PackageDetailPage />);
}

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
    expect(screen.getByRole('link', { name: 'Client packages' })).toHaveAttribute(
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
    expect(screen.getByRole('link', { name: 'Client packages' })).toBeInTheDocument();
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
