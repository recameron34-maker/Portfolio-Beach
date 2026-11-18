import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDEMPOTENCY_KEY_HEADER } from '@pb/contracts';
import type { Principal, ProblemDetails, ReportPackageDetail } from '@pb/contracts';
import type { MockResponse } from '../../../test/api-mock.js';
import { mockApi, ok } from '../../../test/api-mock.js';
import {
  generatedDetailFixture,
  overriddenDetailFixture,
  packageContentFixture,
  packageDetailFixture,
  PKG_ID,
  PKG_PERSON,
} from '../../../test/fixtures-packages.js';
import { refusalFixture, rolePrincipal } from '../../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../../test/render.js';
import { PackageDetailPage } from './PackageDetail.js';
import { EXPLANATION_PROBLEM } from './packages.js';

const params = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: params.id }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/report-packages/${id}`;
const commandPath = (id: string): string => `${detailPath(id)}/commands`;

type Roles = Principal['roles'];

/** What the page reads: `detail` is answered to every read, so a test can move the package behind the page. */
interface World {
  detail: ReportPackageDetail;
}

/**
 * Opens the package page as `roles`. A read answers the package as the world holds it at that
 * moment, and a command answers `command`.
 */
function open(roles: Roles, detail: ReportPackageDetail, command?: MockResponse): World {
  const world: World = { detail };
  params.id = detail.id;
  mockApi({
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(detail.id)]: () => ok(world.detail),
    ...(command === undefined ? {} : { [commandPath(detail.id)]: command }),
  });
  renderWithQuery(<PackageDetailPage />);
  return world;
}

/** The address of a request the page sent through the fetch spy. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

interface SentCommand {
  body: unknown;
  ifMatch: string | null;
  keyed: boolean;
}

/** Every command the page sent: its body, the row version it named and whether it carried a key. */
function sentCommands(): SentCommand[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(
      ([input, init]) => urlOf(input).endsWith('/commands') && init?.method === 'POST',
    )
    .map(([, init]) => {
      const headers = new Headers(init?.headers);
      return {
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        ifMatch: headers.get('if-match'),
        keyed: (headers.get(IDEMPOTENCY_KEY_HEADER) ?? '').length >= 8,
      };
    });
}

/** How many times the page read the package. */
const reads = (id: string): number =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(
      ([input, init]) => urlOf(input) === detailPath(id) && (init?.method ?? 'GET') === 'GET',
    ).length;

/** The buttons of the gate as [name, why it is disabled or null when it is live]. */
function buttons(): [string, string | null][] {
  const actions = screen.queryByTestId('package-actions');
  if (actions === null) return [];
  return within(actions)
    .getAllByRole('button', { hidden: true })
    .map((b) => [
      b.textContent ?? '',
      (b as HTMLButtonElement).disabled ? (b.getAttribute('title') ?? 'disabled') : null,
    ]);
}

/**
 * A button of the gate. Hidden ones are looked at too: after a dialog closes, jsdom may keep the
 * page behind it out of the accessibility tree (a browser lifts that on the focus event).
 */
const button = (name: string): HTMLElement =>
  within(screen.getByTestId('package-actions')).getByRole('button', { name, hidden: true });

/** The one status region of the page, by test id: after a dialog closes jsdom may keep it out of the accessibility tree. */
const status = (): HTMLElement => screen.getByTestId('package-action-status');

const refusal = (status: 403 | 409 | 422, detail: string): MockResponse => ({
  status,
  body: refusalFixture(status, detail),
});

const STALE: ProblemDetails = {
  type: 'https://portfolio-beach.example/problems/precondition-failed',
  title: 'Precondition failed',
  status: 412,
  detail: 'The record changed since it was read',
  request_id: 'test',
};

/* The package at each step of the gate. */
const draft = (): ReportPackageDetail =>
  packageDetailFixture({ id: PKG_ID.failed, basis: 'gross', label: 'final' });
const failed = (): ReportPackageDetail => generatedDetailFixture();
const passed = (): ReportPackageDetail => overriddenDetailFixture();
const inReview = (): ReportPackageDetail =>
  overriddenDetailFixture({ state: 'InReview', rowVersion: 5 });
const approved = (): ReportPackageDetail =>
  overriddenDetailFixture({
    state: 'Approved',
    reviewer: PKG_PERSON.approver,
    approvedAt: '2025-08-18T14:05:00.000Z',
    contentHash: 'a1b2c3d4'.repeat(8),
    rowVersion: 6,
  });
const released = (): ReportPackageDetail => ({
  ...approved(),
  state: 'Released',
  releasedBy: PKG_PERSON.operations,
  releasedAt: '2025-08-19T08:30:00.000Z',
  rowVersion: 7,
});

/** The prior quarter was released and two begin NAVs differ from it: both tie-outs fail unexplained. */
function tieOutBreak(explanations: Record<string, string> = {}): ReportPackageDetail {
  const content = packageContentFixture({
    status: 'preliminary',
    priorRelease: { endNav: { 'INV-0001': '11500000', 'INV-0002': '4300000' }, explanations },
  });
  return generatedDetailFixture(
    { label: 'preliminary', tieOutExplanations: explanations },
    content,
  );
}

const IR = 'Needs investor relations';
const APPROVER = 'Needs approver';

describe('the commands of the release gate, by role and state', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const cases: [string, () => ReportPackageDetail, Roles, [string, string | null][]][] = [
    ['a draft to investor relations', draft, ['investor_relations'], [['Generate', null]]],
    ['a draft to an approver', draft, ['approver'], [['Generate', IR]]],
    [
      'a failed QA to investor relations',
      failed,
      ['investor_relations'],
      [
        ['Regenerate', null],
        ['Override QA', APPROVER],
      ],
    ],
    [
      'a failed QA to an approver',
      failed,
      ['approver'],
      [
        ['Regenerate', IR],
        ['Override QA', null],
      ],
    ],
    ['a passed QA to investor relations', passed, ['investor_relations'], [['Submit', null]]],
    ['a passed QA to an approver', passed, ['approver'], [['Submit', IR]]],
    ['a package in review to an approver', inReview, ['approver'], [['Approve', null]]],
    [
      'a package in review to investor relations',
      inReview,
      ['investor_relations'],
      [['Approve', APPROVER]],
    ],
    ['an approved package to operations', approved, ['operations'], [['Release', null]]],
    [
      'an approved package to investor relations',
      approved,
      ['investor_relations'],
      [['Release', null]],
    ],
    [
      'an approved package to an approver',
      approved,
      ['approver'],
      [['Release', 'Needs investor relations or operations']],
    ],
    // The deal team and the auditor read a package and move nothing.
    [
      'a failed QA to the deal team',
      failed,
      ['deal_team'],
      [
        ['Regenerate', IR],
        ['Override QA', APPROVER],
      ],
    ],
    ['a package in review to an auditor', inReview, ['auditor'], [['Approve', APPROVER]]],
    [
      'an approved package to an auditor',
      approved,
      ['auditor'],
      [['Release', 'Needs investor relations or operations']],
    ],
  ];

  it.each(cases)(
    'offers %s its next step, or names the role it needs',
    async (_n, at, roles, expected) => {
      open(roles, at());
      await screen.findByTestId('package-gate');
      // The roles arrive with the signed-in person: until then every button names the role it needs.
      await waitFor(() => expect(buttons()).toEqual(expected));
    },
  );

  it('offers nothing on a released package: it is read only for every role', async () => {
    for (const roles of [['investor_relations'], ['approver'], ['operations']] as Roles[]) {
      open(roles, released());
      const gate = await screen.findByTestId('package-gate');
      expect(screen.getByTestId('package-next')).toHaveTextContent(
        'Released packages are read only',
      );
      expect(screen.queryByTestId('package-actions')).not.toBeInTheDocument();
      expect(within(gate).queryByRole('button')).not.toBeInTheDocument();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('offers nothing while the checks have not answered: their outcome is for the system to state', async () => {
    open(['investor_relations', 'approver', 'operations'], {
      ...failed(),
      state: 'Generated',
      findings: [],
      qa: { runNo: null, findings: 0, failed: 0, overridden: 0 },
    });
    await screen.findByTestId('package-gate');
    expect(screen.queryByTestId('package-actions')).not.toBeInTheDocument();
  });
});

describe('moving a package through the gate', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('generates a draft under the row version it shows, and then shows what the checks found', async () => {
    const world = open(['investor_relations'], draft(), ok(failed()));
    await waitFor(() => expect(button('Generate')).toBeEnabled());
    // Every read after the command answers the package as the command left it.
    world.detail = failed();
    await userEvent.click(button('Generate'));
    expect(
      await within(status()).findByText(
        'Client Alpha Pension, Q2 2025, gross, version 1 is now QA failed: 1 of 26 checks failed in run 1 (audited)',
      ),
    ).toHaveClass('pb-notice-good');
    expect(sentCommands()).toEqual([
      { body: { command: 'generate' }, ifMatch: '"1"', keyed: true },
    ]);
    // The page is the answer: the state, the failed check and the next steps.
    expect(within(screen.getByTestId('package-banner')).getByText('QA failed')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Checks' })).toHaveTextContent('Expected');
    expect(buttons()).toEqual([
      ['Regenerate', null],
      ['Override QA', APPROVER],
    ]);
    const log = screen.getByRole('list', { name: 'Actions this session' });
    expect(within(log).getByRole('listitem')).toHaveTextContent(/^Done.*is now QA failed/);
  });

  it('carries the row version of the answer on the next command: a generation moves it by two', async () => {
    const regenerated: ReportPackageDetail = { ...failed(), rowVersion: 5 };
    const world = open(['investor_relations'], draft(), ok(failed()));
    await waitFor(() => expect(button('Generate')).toBeEnabled());
    // Every read after the command answers the package as the command left it.
    world.detail = failed();
    await userEvent.click(button('Generate'));
    await within(status()).findByText(/is now QA failed/);
    world.detail = regenerated;
    // The label check failed, not a tie-out: a regeneration has nothing to ask.
    await userEvent.click(button('Regenerate'));
    await waitFor(() => expect(sentCommands()).toHaveLength(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sentCommands()[1]).toEqual({
      body: { command: 'regenerate' },
      ifMatch: '"3"',
      keyed: true,
    });
  });

  it('submits, approves and releases, each under the row version the page shows', async () => {
    const steps: [Roles, ReportPackageDetail, string, ReportPackageDetail, string][] = [
      [['investor_relations'], passed(), 'Submit', inReview(), 'is now In review (audited)'],
      [['approver'], inReview(), 'Approve', approved(), 'is now Approved (audited)'],
      [['operations'], approved(), 'Release', released(), 'is now Released (audited)'],
    ];
    for (const [roles, before, name, after, words] of steps) {
      const world = open(roles, before, ok(after));
      await waitFor(() => expect(button(name)).toBeEnabled());
      world.detail = after;
      await userEvent.click(button(name));
      expect(
        await within(status()).findByText(
          `Client Alpha Pension, Q2 2025, gross, version 1 ${words}`,
        ),
      ).toHaveClass('pb-notice-good');
      expect(sentCommands()).toEqual([
        {
          body: { command: name.toLowerCase() },
          ifMatch: `"${before.rowVersion}"`,
          keyed: true,
        },
      ]);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('shows the hash once the approval answers, and leaves a released package with nothing to press', async () => {
    const world = open(['investor_relations'], approved(), ok(released()));
    await waitFor(() => expect(button('Release')).toBeEnabled());
    expect(screen.getByTestId('package-hash')).toHaveTextContent('a1b2c3d4'.repeat(8));
    world.detail = released();
    await userEvent.click(button('Release'));
    await within(status()).findByText(/is now Released/);
    expect(screen.queryByTestId('package-actions')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Who moved the package' })).toHaveTextContent(
      'Avery Mbeki, Aug 19, 2025 08:30:00 UTC',
    );
  });
});

describe('overriding the failed checks', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks an approver for the reason, says what it is recorded against, and sends it', async () => {
    const world = open(['approver'], failed(), ok(passed()));
    await waitFor(() => expect(button('Override QA')).toBeEnabled());
    await userEvent.click(button('Override QA'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The reason is recorded against the 1 failed check of this run, with your name.',
    );
    const send = within(dialog).getByRole('button', { name: 'Override QA' });
    // A reason of two characters is no reason: nothing leaves the page.
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'ok');
    expect(send).toBeDisabled();
    expect(sentCommands()).toEqual([]);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      ', the stale mark is disclosed in the cover letter',
    );
    world.detail = passed();
    await userEvent.click(send);
    await within(status()).findByText(
      'Client Alpha Pension, Q2 2025, gross, version 1 is now QA passed: 1 failed check overridden (audited)',
    );
    expect(sentCommands()).toEqual([
      {
        body: {
          command: 'overrideQa',
          reason: 'ok, the stale mark is disclosed in the cover letter',
        },
        ifMatch: '"3"',
        keyed: true,
      },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('package-override')).toHaveTextContent(
      '1 failed check overridden by Morgan Lindqvist',
    );
  });

  it('says how many checks a reason covers when more than one failed, and sends nothing on cancel', async () => {
    open(['approver'], tieOutBreak(), ok(passed()));
    await waitFor(() => expect(button('Override QA')).toBeEnabled());
    await userEvent.click(button('Override QA'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The reason is recorded against all 2 failed checks of this run, with your name.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sentCommands()).toEqual([]);
  });
});

describe('explaining a tie-out before a regeneration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const TIMEOUT = { timeout: 20_000 };

  it(
    'asks about each position whose tie-out failed unexplained, beside the two figures compared',
    TIMEOUT,
    async () => {
      open(['investor_relations'], tieOutBreak(), ok(tieOutBreak()));
      await waitFor(() => expect(button('Regenerate')).toBeEnabled());
      await userEvent.click(button('Regenerate'));
      const dialog = await screen.findByRole('dialog');
      expect(sentCommands()).toEqual([]);
      expect(dialog).toHaveTextContent(
        'The begin NAVs of 2 positions do not tie to the last released package.',
      );
      expect(dialog).toHaveTextContent(
        'An explanation stays on the package and cannot be removed.',
      );
      // One box per position, named by the position.
      expect(within(dialog).getAllByRole('textbox')).toHaveLength(2);
      expect(within(dialog).getByRole('textbox', { name: 'INV-0001' })).toHaveValue('');
      expect(within(dialog).getByRole('textbox', { name: 'INV-0002' })).toHaveValue('');
      expect(dialog).toHaveTextContent(
        'Last released $11,500,000.00, begin NAV $11,900,000.00. Optional, 3 to 500 characters.',
      );
      expect(dialog).toHaveTextContent(
        'Last released $4,300,000.00, begin NAV $4,200,000.00. Optional, 3 to 500 characters.',
      );
    },
  );

  it(
    'sends the explanations given, by position, and leaves an empty box out',
    TIMEOUT,
    async () => {
      const explained = tieOutBreak({
        'INV-0002': 'A late distribution was booked to the prior quarter.',
      });
      const world = open(['investor_relations'], tieOutBreak(), ok(explained));
      await waitFor(() => expect(button('Regenerate')).toBeEnabled());
      await userEvent.click(button('Regenerate'));
      const dialog = await screen.findByRole('dialog');
      const send = within(dialog).getByRole('button', { name: 'Regenerate' });
      // An explanation of two characters cannot be sent, and the box says what it needs.
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'INV-0002' }), 'ok');
      await userEvent.click(send);
      expect(await within(dialog).findByText(EXPLANATION_PROBLEM)).toBeInTheDocument();
      expect(send).toBeDisabled();
      expect(sentCommands()).toEqual([]);
      await userEvent.clear(within(dialog).getByRole('textbox', { name: 'INV-0002' }));
      await userEvent.type(
        within(dialog).getByRole('textbox', { name: 'INV-0002' }),
        '  A late distribution was booked to the prior quarter.  ',
      );
      await waitFor(() => expect(send).toBeEnabled());
      world.detail = explained;
      await userEvent.click(send);
      await within(status()).findByText(/is now QA failed: 1 of 28 checks failed in run 1/);
      expect(sentCommands()).toEqual([
        {
          body: {
            command: 'regenerate',
            explanations: { 'INV-0002': 'A late distribution was booked to the prior quarter.' },
          },
          ifMatch: '"3"',
          keyed: true,
        },
      ]);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The position that is explained now is not asked about again; the other still is.
      await userEvent.click(button('Regenerate'));
      const again = await screen.findByRole('dialog');
      expect(within(again).getAllByRole('textbox')).toHaveLength(1);
      expect(within(again).getByRole('textbox', { name: 'INV-0001' })).toBeInTheDocument();
      expect(again).toHaveTextContent(
        'The begin NAV of 1 position does not tie to the last released package.',
      );
    },
  );

  it(
    'regenerates with no explanation when every box is left empty: the record is to be fixed instead',
    TIMEOUT,
    async () => {
      open(['investor_relations'], tieOutBreak(), ok(tieOutBreak()));
      await waitFor(() => expect(button('Regenerate')).toBeEnabled());
      await userEvent.click(button('Regenerate'));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
      await waitFor(() => expect(sentCommands()).toHaveLength(1));
      expect(sentCommands()[0]).toEqual({
        body: { command: 'regenerate' },
        ifMatch: '"3"',
        keyed: true,
      });
    },
  );
});

describe('a command the API refuses', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers Approve to every approver and shows the refusal the preparer gets, without the control it cites', async () => {
    open(
      ['approver'],
      inReview(),
      refusal(422, 'reporting_package: the package preparer cannot approve it (SEC-5.6)'),
    );
    await waitFor(() => expect(button('Approve')).toBeEnabled());
    expect(button('Approve')).not.toHaveAttribute('title');
    await userEvent.click(button('Approve'));
    const said = await within(status()).findByText(
      'Approve: Blocked by a rule. The package preparer cannot approve it',
    );
    expect(said).toHaveClass('pb-notice-bad');
    expect(document.body.textContent).not.toMatch(/SEC-|reporting_package/);
    // Nothing moved: the package is still in review and the step is still offered.
    expect(within(screen.getByTestId('package-banner')).getByText('In review')).toBeInTheDocument();
    expect(buttons()).toEqual([['Approve', null]]);
    const log = screen.getByRole('list', { name: 'Actions this session' });
    expect(within(log).getByRole('listitem')).toHaveTextContent(
      /^Refused.*preparer cannot approve/,
    );
  });

  it('says that somebody moved the package first, reads it again and offers what stands now', async () => {
    const world = open(['investor_relations'], passed(), { status: 412, body: STALE });
    await waitFor(() => expect(button('Submit')).toBeEnabled());
    const before = reads(PKG_ID.failed);
    // Another investor relations user submitted it meanwhile: the row version has moved on.
    world.detail = inReview();
    await userEvent.click(button('Submit'));
    expect(
      await within(status()).findByText(
        'Submit: Someone changed this package first, so nothing was done. The page now shows it as it stands.',
      ),
    ).toHaveClass('pb-notice-bad');
    expect(sentCommands()).toEqual([{ body: { command: 'submit' }, ifMatch: '"4"', keyed: true }]);
    // The refusal reads the package again; the page then shows where it stands and what is next.
    await waitFor(() => expect(reads(PKG_ID.failed)).toBeGreaterThan(before));
    expect(
      await within(screen.getByTestId('package-banner')).findByText('In review'),
    ).toBeInTheDocument();
    await waitFor(() => expect(buttons()).toEqual([['Approve', APPROVER]]));
    // The command was sent once: a stale try is never repeated for the person.
    expect(sentCommands()).toHaveLength(1);
  });

  it('shows a refusal by role in plain words', async () => {
    open(
      ['operations'],
      approved(),
      refusal(403, 'reporting_package: release from Approved requires one of: investor_relations'),
    );
    await waitFor(() => expect(button('Release')).toBeEnabled());
    await userEvent.click(button('Release'));
    expect(await within(status()).findByText(/^Release: Your role cannot do this\./)).toHaveClass(
      'pb-notice-bad',
    );
    expect(within(screen.getByTestId('package-banner')).getByText('Approved')).toBeInTheDocument();
  });
});
