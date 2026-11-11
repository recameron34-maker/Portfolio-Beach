import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  allocationsPutBody,
  changeRequestCommandBody,
  changeRequestCreateBody,
  pageQuery,
  valuationCommandBody,
  valuationCreateBody,
  valuationEditBody,
  wireInstructionCommandBody,
  wireInstructionProposeBody,
} from '@pb/contracts';
import type { ProblemDetails, ValuationRow } from '@pb/contracts';
import { ApiError } from '../api/client.js';
import {
  describeActionError,
  describeRefusal,
  fieldLabel,
  NOTICE_KEYS,
  plainRule,
  postIntakeCommand,
  postIntakeImport,
  postPreviewReset,
  postValuationCommand,
} from './mutations.js';
import { intakeFileDetailFixture, intakeImportResultFixture } from '../test/fixtures-intake.js';
import { clearCredential, setCredential } from './session.js';

/** A contract-shaped valuation row; page tests can copy it. */
export const VALUATION_FIXTURE: ValuationRow = {
  id: '11111111-1111-4111-8111-111111111111',
  investmentId: '22222222-2222-4222-8222-222222222222',
  investmentNumber: 'PB-0007',
  companyName: 'Harbor Lights Holdings',
  vehicleName: 'Beach Co-Invest Fund III',
  dealType: 'deal_type.co_invest_equity',
  periodEnd: '2025-06-30',
  quarterEnd: '2025-06-30',
  version: 1,
  state: 'OpsPrepared',
  method: 'valuation_method.market_multiple',
  fairValue: '12500000',
  priorFairValue: '11800000',
  changePct: '0.0593',
  lockHash: null,
  preparedBy: '33333333-3333-4333-8333-333333333333',
  dealTeamApprovedBy: null,
  approvedBy: null,
  approvedAt: null,
  reopenReason: null,
  rowVersion: 2,
};

const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const problem = (status: number, detail: string): ApiError =>
  new ApiError({
    type: 'https://portfolio-beach.example/problems/x',
    title: 'Refused',
    status,
    detail,
    request_id: 'test',
  });

describe('workflow mutations', () => {
  beforeEach(() => setCredential('ops.one'));
  afterEach(() => {
    vi.restoreAllMocks();
    clearCredential();
  });

  it('posts a command as JSON with the bearer credential and parses the row', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, { ...VALUATION_FIXTURE, state: 'DealTeamApproved' }));
    const row = await postValuationCommand(VALUATION_FIXTURE.id, { command: 'dealTeamApprove' });
    expect(row.state).toBe('DealTeamApproved');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/valuations/${VALUATION_FIXTURE.id}/commands`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ command: 'dealTeamApprove' }));
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer ops.one');
  });

  it('stages an export as text and issues intake commands on the file', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(201, intakeImportResultFixture(true)))
      .mockResolvedValueOnce(json(200, intakeFileDetailFixture()));
    const staged = await postIntakeImport({ fileName: 'export.csv', csv: 'A,B\n1,2\n' });
    expect(staged.duplicate).toBe(true);
    const detail = await postIntakeCommand(staged.id, { command: 'reject', reason: 'Not ours' });
    expect(detail.id).toBe(staged.id);
    const [first, second] = fetchSpy.mock.calls as [string, RequestInit][];
    expect(first?.[0]).toBe('/api/v1/intake/accounting');
    expect(first?.[1].body).toBe(JSON.stringify({ fileName: 'export.csv', csv: 'A,B\n1,2\n' }));
    expect(second?.[0]).toBe(`/api/v1/intake/files/${staged.id}/commands`);
    expect(second?.[1].body).toBe(JSON.stringify({ command: 'reject', reason: 'Not ours' }));
  });

  it('sends the preview reset without a body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { reset: true }));
    await expect(postPreviewReset()).resolves.toEqual({ reset: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('raises the problem as an ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        409,
        {
          type: 'https://portfolio-beach.example/problems/workflow-transition',
          title: 'Conflict',
          status: 409,
          detail: 'valuation: lock is not allowed from Draft',
          request_id: 'preview',
        },
        'application/problem+json',
      ),
    );
    await expect(postValuationCommand('x', { command: 'lock' })).rejects.toMatchObject({
      status: 409,
    });
  });
});

/** A 400 as the API answers a body its contract refuses: one entry per issue, the path and the message. */
const invalid = (
  errors: NonNullable<ProblemDetails['errors']>,
  detail = 'Invalid body',
): ApiError =>
  new ApiError({
    type: 'https://portfolio-beach.example/problems/validation',
    title: 'Bad request',
    status: 400,
    detail,
    request_id: 'test',
    errors,
  });

/** The issues a contract schema reports for a body, as the API and the preview list them. */
function issuesOf(schema: z.ZodTypeAny, body: unknown): NonNullable<ProblemDetails['errors']> {
  const parsed = schema.safeParse(body);
  if (parsed.success) throw new Error('expected the body to be refused');
  return parsed.error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

const coded = (status: number, code: string, detail: string): ApiError =>
  new ApiError({
    type: `https://portfolio-beach.example/problems/${code}`,
    title: 'Refused',
    status,
    detail,
    request_id: 'test',
  });

describe('a validation refusal (review finding WEB-4)', () => {
  it('names each field and says what is wrong with it, instead of "Invalid body"', () => {
    const one = describeActionError(
      invalid([{ path: 'fairValue', message: 'Must be above zero' }]),
    );
    expect(one).toBe('The request was not valid. Fair value: Must be above zero.');
    expect(one).not.toContain('Invalid body');
    expect(
      describeActionError(
        invalid([
          { path: 'periodEnd', message: 'Not a real calendar date' },
          { path: 'reason', message: 'A reason is required' },
        ]),
      ),
    ).toBe(
      'The request was not valid. Period end: Not a real calendar date. Reason: A reason is required.',
    );
  });

  it('words a field path for a person: nested fields, lines of a list, and ids by what they name', () => {
    expect(fieldLabel('fairValue')).toBe('Fair value');
    expect(fieldLabel('bankDetails.accountNumber')).toBe('Bank details, account number');
    expect(fieldLabel('allocations.0.requested')).toBe('Allocations, line 1, requested');
    expect(fieldLabel('allocations.11.vehicleId')).toBe('Allocations, line 12, vehicle');
    expect(fieldLabel('investmentId')).toBe('Investment');
    expect(fieldLabel('rowIds')).toBe('Rows');
    expect(fieldLabel('id')).toBe('Id');
    expect(fieldLabel('icDecision')).toBe('IC decision');
    expect(fieldLabel('limit')).toBe('Limit');
    // The body as a whole has no field: the message stands alone.
    expect(fieldLabel('(root)')).toBeNull();
    expect(fieldLabel('')).toBeNull();
  });

  it('puts the messages the contracts produce today into plain words', () => {
    const said = (schema: z.ZodTypeAny, body: unknown): string =>
      describeActionError(invalid(issuesOf(schema, body)));
    expect(
      said(valuationCreateBody, {
        investmentId: 'x',
        periodEnd: '2025-02-30',
        method: '',
        fairValue: '0.00',
      }),
    ).toBe(
      'The request was not valid. Investment: Not in the expected format. Period end: Not a real calendar date. Method: Required. Fair value: Must be above zero.',
    );
    expect(
      said(valuationCreateBody, {
        investmentId: '30000000-0000-4000-8000-000000000001',
        periodEnd: '2025-06-30',
        method: 'valuation_method.sponsor_mark',
      }),
    ).toBe('The request was not valid. Fair value: Required.');
    expect(said(valuationCommandBody, { command: 'nope', reason: 'x' })).toBe(
      'The request was not valid. Command: Not one of the allowed values. Reason: Needs at least 3 characters.',
    );
    expect(said(changeRequestCommandBody, { command: 'zzz' })).toBe(
      'The request was not valid. Command: Not one of the allowed values.',
    );
    expect(said(changeRequestCommandBody, { command: 'apply', appliedPeriod: '2025-05-31' })).toBe(
      'The request was not valid. Applied period: Not a quarter end.',
    );
    expect(
      said(changeRequestCreateBody, {
        investmentId: '30000000-0000-4000-8000-000000000001',
        changeType: 'bad',
        effectiveDate: '2025-06-30',
        summary: 'x'.repeat(5000),
      }),
    ).toMatch(
      /^The request was not valid\. Change type: Not in the expected format\. Summary: Allows at most \d+ characters\.$/,
    );
    expect(
      said(wireInstructionProposeBody, {
        sponsorFundId: '30000000-0000-4000-8000-000000000011',
        counterpartyName: 'A fund',
        bankDetails: { bankName: 'A bank', accountName: 'A fund', routingCode: '021000021' },
      }),
    ).toBe('The request was not valid. Bank details, account number: Required.');
    expect(
      said(wireInstructionCommandBody, {
        command: 'reject',
        callbackResult: 'not_confirmed',
        reason: 'The callback failed',
      }),
    ).toBe(
      'The request was not valid. Callback number source: The number source is required with a callback result.',
    );
    expect(
      said(allocationsPutBody, {
        allocations: [
          { vehicleId: '30000000-0000-4000-8000-000000000010', requested: '1.00' },
          { vehicleId: '30000000-0000-4000-8000-000000000012', requested: 5 },
        ],
      }),
    ).toBe(
      'The request was not valid. Allocations, line 2, requested: Not the expected kind of value.',
    );
    expect(said(pageQuery, { limit: '999' })).toBe(
      'The request was not valid. Limit: Must be 200 or less.',
    );
    // An issue about the body as a whole stands without a field.
    expect(said(valuationEditBody, {})).toBe(
      'The request was not valid. Give at least one of method, fairValue and inputs.',
    );
    expect(said(valuationCommandBody, { command: 'prepare', extra: 1, other: 2 })).toBe(
      'The request was not valid. The server does not accept these fields: extra, other.',
    );
  });

  it('keeps a message it does not know as the API wrote it, and never shows a pattern', () => {
    expect(describeActionError(invalid([{ path: 'ownerId', message: 'Unknown user' }]))).toBe(
      'The request was not valid. Owner: Unknown user.',
    );
    const pattern = describeActionError(
      invalid([
        {
          path: 'changeType',
          message: 'Invalid string: must match pattern /^change_type\\.[a-z0-9_]+$/',
        },
      ]),
    );
    expect(pattern).toBe('The request was not valid. Change type: Not in the expected format.');
  });

  it('lists the first five issues and counts the rest', () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      path: `allocations.${i}.requested`,
      message: 'Must be above zero',
    }));
    const said = describeActionError(invalid(errors));
    expect(said).toContain('Allocations, line 5, requested: Must be above zero.');
    expect(said).not.toContain('line 6');
    expect(said.endsWith('And 3 more.')).toBe(true);
  });

  it("says a refused header is the app's fault, not the person's, and still names it", () => {
    const key = describeActionError(
      invalid(
        [{ path: 'Idempotency-Key', message: 'Expected 1 to 200 visible ASCII characters' }],
        'Invalid Idempotency-Key',
      ),
    );
    expect(key).toBe(
      'The app sent a request the server could not read (Idempotency-Key header: Expected 1 to 200 visible ASCII characters). Nothing was changed. Reload the page and try again.',
    );
    expect(
      describeActionError(
        invalid(
          [{ path: 'If-Match', message: 'Expected the row version as an entity tag' }],
          'Invalid If-Match',
        ),
      ),
    ).toBe(
      'The app sent a request the server could not read (If-Match header: Expected the row version as an entity tag). Nothing was changed. Reload the page and try again.',
    );
  });

  it('keeps the detail of a 400 that lists no issues', () => {
    expect(describeActionError(coded(400, 'validation', 'Invalid cursor'))).toBe(
      'The request was not valid. Invalid cursor',
    );
    expect(describeActionError(invalid([], 'Invalid cursor'))).toBe(
      'The request was not valid. Invalid cursor',
    );
  });
});

describe('an Idempotency-Key refusal (docs/17 section 3)', () => {
  it('tells the person to wait and check the record while the first request is still running', () => {
    const said = describeActionError(
      coded(
        409,
        'idempotency-key-in-progress',
        'A request with this Idempotency-Key is still running. Wait for its answer, or read the record again and send the request with a new key',
      ),
    );
    expect(said).toBe(
      'This action is still running from an earlier try. Wait a moment, then check the record before you try again.',
    );
    expect(said).not.toMatch(/Idempotency|current state/);
  });

  it("says a reused key is the app's fault and that nothing changed", () => {
    const said = describeActionError(
      coded(
        422,
        'idempotency-key-reuse',
        'This Idempotency-Key was already used with a different request body',
      ),
    );
    expect(said).toBe(
      'The app repeated an earlier request with different content, and the server refused it. Nothing was changed. Try again.',
    );
    expect(said).not.toMatch(/Idempotency|Blocked by a rule/);
  });
});

describe('describeActionError', () => {
  it('turns each refusal status into one plain sentence without echoing values', () => {
    expect(describeActionError(problem(403, 'lock requires one of: approver'))).toBe(
      'Your role cannot do this. Lock requires one of: approver',
    );
    expect(describeActionError(problem(409, 'lock is not allowed from Draft'))).toBe(
      'Not allowed from the current state. Lock is not allowed from Draft',
    );
    expect(describeActionError(problem(422, 'the preparer cannot approve (SEC-5.6)'))).toBe(
      'Blocked by a rule. The preparer cannot approve (SEC-5.6)',
    );
    expect(describeActionError(problem(412, 'stale-row-version'))).toMatch(
      /changed this record first/,
    );
    expect(describeActionError(problem(400, 'command: invalid'))).toMatch(/not valid/);
    expect(describeActionError(problem(401, 'expired'))).toMatch(/Sign in again/);
    expect(describeActionError(problem(501, 'not implemented'))).toBe(
      'This build does not serve that action yet.',
    );
    expect(describeActionError(problem(404, 'Valuation not found'))).toBe('Valuation not found');
    expect(describeRefusal(422, 'valuation: the preparer cannot approve (SEC-5.6)')).toBe(
      'Blocked by a rule. The preparer cannot approve (SEC-5.6)',
    );
    expect(describeActionError(new Error('network down'))).toBe('network down');
    expect(describeActionError('odd')).toBe('The action failed.');
  });

  it('words a transition-table refusal for the user, not the engineer', () => {
    expect(plainRule('valuation: lock from DealTeamApproved requires one of: approver')).toBe(
      'Lock from Deal team approved requires one of: approver',
    );
    expect(plainRule('capital_notice: confirmFunding is not allowed from TicketDrafted')).toBe(
      'Confirm funding is not allowed from Ticket drafted',
    );
    expect(plainRule('Valuation not found')).toBe('Valuation not found');
    expect(
      describeActionError(
        problem(422, 'capital_notice: the ticket preparer cannot approve it (SEC-12.3)'),
      ),
    ).toBe('Blocked by a rule. The ticket preparer cannot approve it (SEC-12.3)');
  });

  it('never contains an em dash', () => {
    const dash = String.fromCharCode(0x2014);
    for (const status of [400, 401, 403, 404, 409, 412, 422, 501, 500])
      expect(describeActionError(problem(status, 'detail'))).not.toContain(dash);
    for (const said of [
      describeActionError(invalid([{ path: 'fairValue', message: 'Must be above zero' }])),
      describeActionError(invalid([{ path: 'If-Match', message: 'x' }])),
      describeActionError(coded(409, 'idempotency-key-in-progress', 'x')),
      describeActionError(coded(422, 'idempotency-key-reuse', 'x')),
    ])
      expect(said).not.toContain(dash);
  });
});

describe('refreshing after a write', () => {
  it('refreshes every read a Locked valuation or a funded notice can change', async () => {
    const { QueryClient } = await import('@tanstack/react-query');
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { createElement } = await import('react');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { useValuationCommand } = await import('./mutations.js');
    setCredential('head.one');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(200, { ...VALUATION_FIXTURE, state: 'Locked' }),
    );
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useValuationCommand(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    result.current.mutate({ id: VALUATION_FIXTURE.id, body: { command: 'lock' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of [
      'valuations',
      'valuation',
      'investment',
      'vehicle',
      'sponsor',
      'analytics-summary',
      'weekly-report',
    ])
      expect(keys).toContain(JSON.stringify([key]));
    // A notice command drafts or approves a ticket against the register (SEC-12.3).
    for (const key of ['trade-tickets', 'trade-ticket', 'wire-instructions', 'wire-instruction'])
      expect(NOTICE_KEYS).toContainEqual([key]);
  });
});
