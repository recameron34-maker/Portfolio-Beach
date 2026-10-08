import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValuationRow } from '@pb/contracts';
import { ApiError } from '../api/client.js';
import {
  describeActionError,
  plainRule,
  postPreviewReset,
  postValuationCommand,
} from './mutations.js';
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
    expect(describeActionError(problem(412, 'stale'))).toMatch(/changed this record first/);
    expect(describeActionError(problem(400, 'command: invalid'))).toMatch(/not valid/);
    expect(describeActionError(problem(401, 'expired'))).toMatch(/Sign in again/);
    expect(describeActionError(problem(501, 'not implemented'))).toMatch(/Phase 3/);
    expect(describeActionError(problem(404, 'Cannot POST'))).toMatch(/Phase 3/);
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
    for (const status of [400, 401, 403, 404, 409, 412, 422, 501, 500])
      expect(describeActionError(problem(status, 'detail'))).not.toContain(
        String.fromCharCode(0x2014),
      );
  });
});
