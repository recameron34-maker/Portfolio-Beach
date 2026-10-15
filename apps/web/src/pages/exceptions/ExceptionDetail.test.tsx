import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DataException } from '@pb/contracts';
import { failing, mockApi, ok } from '../../test/api-mock.js';
import type { MockRoutes } from '../../test/api-mock.js';
import {
  afterCommandFixture,
  EXCEPTION_ID,
  exceptionFixture,
  exceptions,
} from '../../test/fixtures-exceptions.js';
import { RUN_ID } from '../../test/fixtures-lookthrough.js';
import {
  POSITION_ID,
  rolePrincipal,
  sentPosts,
  sentRequests,
} from '../../test/fixtures-valuations.js';
import { renderWithQuery } from '../../test/render.js';
import { ExceptionDetailPage } from './ExceptionDetail.js';

const route = vi.hoisted(() => ({ id: '' }));

vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../test/router-mock.js')).routerMock(),
  useParams: () => ({ id: route.id }),
}));

const ME = '/api/v1/auth/me';
const detailPath = (id: string): string => `/api/v1/data-exceptions/${id}`;
const commandsPath = (id: string): string => `${detailPath(id)}/commands`;
/** Dialog journeys drive Fluent popovers; give them room on a loaded test runner. */
const TIMEOUT = { timeout: 15_000 };

function routes(
  roles: Parameters<typeof rolePrincipal>[0] = ['operations'],
  overrides: MockRoutes = {},
): MockRoutes {
  route.id = EXCEPTION_ID.nav;
  return {
    [ME]: ok(rolePrincipal(roles)),
    [detailPath(EXCEPTION_ID.nav)]: ok(exceptionFixture()),
    ...overrides,
  };
}

/** The exception as the API serves it after a command: the answer to the POST, and to the refetch that follows it. */
function afterCommand(
  after: DataException,
  before: DataException = exceptionFixture(),
): MockRoutes {
  return {
    [detailPath(before.id)]: () => ok(sentPosts().length > 0 ? after : before),
    [commandsPath(before.id)]: ok(after),
  };
}

const banner = (): HTMLElement => screen.getByTestId('exception-banner');
const status = (): HTMLElement => screen.getByTestId('exception-action-status');

/** Fluent lifts the modal's aria-hidden a moment after the dialog unmounts; then the status region is reachable again. */
async function dialogClosed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await screen.findByRole('status', {}, TIMEOUT);
}

describe('an exception', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows what the intake found, where, and the actions open to operations', async () => {
    mockApi(routes());
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    expect(within(banner()).getByRole('heading', { level: 1 })).toHaveTextContent('LT-TIE-01');
    expect(banner()).toHaveTextContent('Look-through reconcile');
    expect(banner()).toHaveTextContent('Opened Jul 2, 2025 10:15:00 UTC');
    expect(within(banner()).getByText('High')).toHaveClass('pb-badge-bad');
    expect(within(banner()).getByText('Open')).toHaveClass('pb-badge-watch');
    expect(screen.getByRole('link', { name: 'All exceptions' })).toHaveAttribute(
      'href',
      '/data/exceptions',
    );
    const detail = screen.getByRole('table', { name: 'Exception' });
    const value = (label: string): HTMLElement =>
      within(detail).getByRole('rowheader', { name: label }).nextElementSibling as HTMLElement;
    expect(value('Expected')).toHaveTextContent('20000000.00');
    expect(value('Actual')).toHaveTextContent('21500000.00');
    expect(
      within(value('Context')).getByRole('link', { name: 'lookthrough-2025-06-30.json' }),
    ).toHaveAttribute('href', `/data/lookthrough/${RUN_ID.defects}`);
    expect(within(value('Context')).getByText('Row 2')).toHaveClass('pb-key');
    expect(
      within(value('Context')).getByRole('link', { name: 'INV-0004 Silverline Staffing Holdings' }),
    ).toHaveAttribute('href', `/portfolio/${POSITION_ID.silverline}`);
    expect(value('Candidates')).toHaveTextContent('-');
    expect(value('Owner')).toHaveTextContent('-');
    expect(value('External ticket')).toHaveTextContent('-');
    expect(value('Updated')).toHaveTextContent('Jul 2, 2025 10:15:00 UTC');

    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: "Won't fix" })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'External ticket' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Set ticket' })).toBeDisabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('acknowledges with one click: the operator takes it and the state moves', async () => {
    mockApi(routes(['operations'], afterCommand(afterCommandFixture('acknowledge'))));
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText('Acknowledged, taken by Avery Castellanos (audited)'),
    ).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(EXCEPTION_ID.nav), { command: 'acknowledge' }]]);
    await waitFor(() =>
      expect(within(banner()).getByText('Acknowledged')).toHaveClass('pb-badge-brand'),
    );
    // From acknowledged the table lists resolve and won't fix only.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: "Won't fix" })).toBeEnabled();
  });

  it('resolves only with a reason, then says the state is final', TIMEOUT, async () => {
    const reason = 'The provider restated the mark; the record stands';
    mockApi(routes(['operations'], afterCommand(afterCommandFixture('resolve'))));
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('LT-TIE-01 from Look-through reconcile, Row 2');
    const submit = within(dialog).getByRole('button', { name: 'Resolve' });
    expect(submit).toBeDisabled();
    expect(sentPosts()).toEqual([]);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await dialogClosed();
    expect(await screen.findByText('Resolved (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([[commandsPath(EXCEPTION_ID.nav), { command: 'resolve', reason }]]);
    await waitFor(() =>
      expect(within(banner()).getByText('Resolved')).toHaveClass('pb-badge-good'),
    );
    expect(screen.getByTestId('exception-terminal')).toHaveTextContent('Resolved is final');
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    // The ticket can still be noted on a closed exception.
    expect(screen.getByRole('textbox', { name: 'External ticket' })).toBeInTheDocument();
  });

  it("closes as won't fix with a reason", TIMEOUT, async () => {
    const reason = 'The provider has no label for this sector; mapped by hand';
    mockApi(routes(['operations'], afterCommand(afterCommandFixture('wont_fix'))));
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    await userEvent.click(screen.getByRole('button', { name: "Won't fix" }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
    await userEvent.click(within(dialog).getByRole('button', { name: "Won't fix" }));
    await dialogClosed();
    expect(await screen.findByText("Closed as won't fix (audited)")).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [commandsPath(EXCEPTION_ID.nav), { command: 'wont_fix', reason }],
    ]);
    await waitFor(() =>
      expect(within(banner()).getByText("Won't fix")).toHaveClass('pb-badge-neutral'),
    );
  });

  it('sets the external ticket without a state change', async () => {
    mockApi(routes(['operations'], afterCommand(afterCommandFixture('set_ticket'))));
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    const input = screen.getByRole('textbox', { name: 'External ticket' });
    await userEvent.type(input, 'HD-2000');
    const set = screen.getByRole('button', { name: 'Set ticket' });
    expect(set).toBeEnabled();
    await userEvent.click(set);
    expect(await screen.findByText('Ticket HD-2000 noted (audited)')).toBeInTheDocument();
    expect(sentPosts()).toEqual([
      [commandsPath(EXCEPTION_ID.nav), { command: 'set_ticket', externalTicket: 'HD-2000' }],
    ]);
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Exception' })).toHaveTextContent('HD-2000'),
    );
    expect(within(banner()).getByText('Open')).toHaveClass('pb-badge-watch');
  });

  it('words a refused command in the status region and keeps the exception as it was', async () => {
    mockApi(
      routes(['operations'], {
        [commandsPath(EXCEPTION_ID.nav)]: failing(403, commandsPath(EXCEPTION_ID.nav)),
      }),
    );
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText('Acknowledge: Your role cannot do this. Your role may not read this'),
    ).toBeInTheDocument();
    expect(status()).toHaveClass('pb-action-status');
    expect(within(banner()).getByText('Open')).toBeInTheDocument();
  });

  it('keeps the skeleton until the roles are known, so operations never reads the read-only note for a moment', async () => {
    mockApi(routes(['operations']));
    // The exception answers at once; the identity waits until the test releases it.
    const answer = vi.mocked(globalThis.fetch).getMockImplementation();
    if (answer === undefined) throw new Error('fetch is not mocked');
    let release: ((response: Response) => void) | null = null;
    const identity = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(raw, 'http://test.local').pathname === ME ? identity : answer(input, init);
    });
    renderWithQuery(<ExceptionDetailPage />);
    await waitFor(() => expect(sentRequests().map(([url]) => url)).toContain(ME));
    await waitFor(() =>
      expect(sentRequests().map(([url]) => url)).toContain(detailPath(EXCEPTION_ID.nav)),
    );
    // Let the exception's answer settle: the page still waits for the roles.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByTestId('exception-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exception-read-only')).not.toBeInTheDocument();

    if (release === null) throw new Error('the identity request was never made');
    (release as (response: Response) => void)(
      new Response(JSON.stringify(rolePrincipal(['operations'])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await screen.findByTestId('exception-banner');
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    expect(screen.queryByTestId('exception-read-only')).not.toBeInTheDocument();
  });

  it('offers no action to the reviewing roles, and no transition on a closed exception', async () => {
    mockApi(routes(['deal_team']));
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    expect(screen.getByTestId('exception-read-only')).toHaveTextContent(
      'Operations works the queue; your role reads it.',
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'External ticket' })).not.toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    const resolved = exceptions().find((x) => x.id === EXCEPTION_ID.resolved)!;
    mockApi(routes(['operations'], { [detailPath(EXCEPTION_ID.resolved)]: ok(resolved) }));
    route.id = EXCEPTION_ID.resolved;
    renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    expect(screen.getByTestId('exception-terminal')).toHaveTextContent(
      'Resolved is final: a problem that comes back opens a new exception.',
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'External ticket' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Exception' })).toHaveTextContent('Avery Castellanos');
  });

  it('says not found on a 404, who the queue is for on a 403, and degrades on a 501', async () => {
    const cases: [403 | 404 | 501, string][] = [
      [404, 'Exception not found or not visible to you'],
      [403, 'Exceptions are for operations and reviewers'],
      [501, 'This exception: not available yet'],
    ];
    for (const [code, text] of cases) {
      cleanup();
      vi.restoreAllMocks();
      mockApi(
        routes(['viewer'], {
          [detailPath(EXCEPTION_ID.nav)]: failing(code, detailPath(EXCEPTION_ID.nav)),
        }),
      );
      renderWithQuery(<ExceptionDetailPage />);
      expect(await screen.findByText(text), String(code)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All exceptions' })).toBeInTheDocument();
    }
  });

  it('never shows an em dash', async () => {
    mockApi(routes());
    const { container } = renderWithQuery(<ExceptionDetailPage />);
    await screen.findByTestId('exception-banner');
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
