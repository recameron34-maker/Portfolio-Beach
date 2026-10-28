import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  allocationsPutBody,
  bankDetails,
  capitalNoticeCommandBody,
  capitalNoticeControlDetail,
  changeRequestCommandBody,
  changeRequestCreateBody,
  changeRequestRow,
  closingCommandBody,
  closingDetail,
  closingItemCommandBody,
  diligenceTaskCommandBody,
  diligenceTaskCreateBody,
  icDecisionBody,
  legalTermCommandBody,
  legalTermCreateBody,
  opportunityCommandBody,
  opportunityCreateBody,
  opportunityDetail,
  quarterEndCheckBody,
  quarterEndCheckResult,
  tradeTicketRow,
  valuationBatchCommandBody,
  valuationBatchResult,
  valuationCommandBody,
  valuationCreateBody,
  valuationDetail,
  wireInstructionCommandBody,
  wireInstructionDetail,
  wireInstructionProposeBody,
} from './controls.js';
import * as controls from './controls.js';
import { canonicalJson, valuationLockText } from './lock.js';
import { buildOpenApi } from './openapi.js';
import { API_PREFIX, ROUTES } from './routes.js';
import { CONTROL_ROUTES } from './routes-controls.js';
import { capitalNoticeDetail, valuationRow } from './schemas.js';
import * as simulated from './simulated.js';
import { SIMULATED_ROUTES } from './simulated.js';

const INV = '30000000-0000-4000-8000-000000000001';
const FUND = '20000000-0000-4000-8000-000000000002';
const SPONSOR = '20000000-0000-4000-8000-000000000001';
const VEHICLE = '30000000-0000-4000-8000-0000000000b1';
const CLIENT = '30000000-0000-4000-8000-0000000000c1';
const DOC = 'a0000000-0000-4000-8000-000000000001';
const NOTICE = '50000000-0000-4000-8000-000000000001';
const WIRE = '60000000-0000-4000-8000-000000000001';
const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const ID = '70000000-0000-4000-8000-000000000001';
const AT = '2025-10-20T12:00:00Z';

const opsOne = { id: USER_A, name: 'Ops One' };
const headOne = { id: USER_B, name: 'Head One' };

/** True when the schema accepts the value; the failing issue paths otherwise, for a readable assertion. */
function parses(schema: z.ZodTypeAny, value: unknown): true | string[] {
  const result = schema.safeParse(value);
  return result.success
    ? true
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('CONTROL_ROUTES', () => {
  it('stays under the API prefix, names its roles and authenticates every route', () => {
    expect(CONTROL_ROUTES.length).toBeGreaterThan(0);
    for (const route of CONTROL_ROUTES) {
      const key = `${route.method} ${route.path}`;
      expect(route.path.startsWith(`${API_PREFIX}/`), key).toBe(true);
      expect(route.roles.length, key).toBeGreaterThan(0);
      expect(route.auth, key).toBe(true);
      expect(route.tags.length, key).toBeGreaterThan(0);
    }
  });

  it('defines each method and path once and is served through ROUTES since wave 2', () => {
    const keys = CONTROL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const served = ROUTES.map((r) => `${r.method} ${r.path}`);
    // Every control route is in the served table exactly once, beside the routes that were there.
    expect(new Set(served).size).toBe(served.length);
    expect(keys.filter((k) => !served.includes(k))).toEqual([]);
    expect(ROUTES.length).toBeGreaterThan(CONTROL_ROUTES.length);
    for (const route of CONTROL_ROUTES) expect(ROUTES).toContain(route);
  });

  it('took the three simulated writes over, leaving SIMULATED_ROUTES the preview reset alone', () => {
    const keys = new Set(CONTROL_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const path of [
      `${API_PREFIX}/valuations`,
      `${API_PREFIX}/valuations/{id}/commands`,
      `${API_PREFIX}/capital-notices/{id}/commands`,
    ])
      expect(keys.has(`POST ${path}`), path).toBe(true);
    expect(SIMULATED_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${API_PREFIX}/preview/reset`,
    ]);
    expect(keys.has(`POST ${API_PREFIX}/preview/reset`)).toBe(false);
  });

  it('gives every write a body and marks every command and create idempotent', () => {
    for (const route of CONTROL_ROUTES) {
      const key = `${route.method} ${route.path}`;
      if (route.method === 'GET') {
        expect(route.body, key).toBeUndefined();
        expect(route.idempotent, key).toBeUndefined();
      } else {
        expect(route.body, key).toBeDefined();
        expect(route.idempotent, key).toBe(true);
      }
    }
  });

  it('keeps the commands away from roles that only read, and the reads open to auditors', () => {
    const byKey = new Map(CONTROL_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    const roles = (key: string): readonly string[] => {
      const route = byKey.get(key);
      if (route === undefined) throw new Error(`missing ${key}`);
      return route.roles;
    };
    expect(roles(`POST ${API_PREFIX}/valuations`)).toEqual(['operations']);
    expect(roles(`POST ${API_PREFIX}/valuations/batch-commands`)).toEqual([
      'deal_team',
      'approver',
    ]);
    expect(roles(`POST ${API_PREFIX}/wire-instructions`)).toEqual(['operations']);
    expect(roles(`POST ${API_PREFIX}/wire-instructions/{id}/commands`)).toEqual([
      'operations',
      'approver',
    ]);
    expect(roles(`POST ${API_PREFIX}/opportunities/{id}/ic-decisions`)).toEqual(['approver']);
    expect(roles(`POST ${API_PREFIX}/closings/{id}/commands`)).toEqual(['operations']);
    expect(roles(`POST ${API_PREFIX}/change-requests/quarter-end-check`)).toEqual(['operations']);
    for (const key of [
      `GET ${API_PREFIX}/wire-instructions`,
      `GET ${API_PREFIX}/trade-tickets`,
      `GET ${API_PREFIX}/change-requests`,
      `GET ${API_PREFIX}/opportunities`,
      `GET ${API_PREFIX}/closings/{id}`,
      `GET ${API_PREFIX}/valuations/{id}`,
    ]) {
      expect(roles(key), key).toContain('auditor');
      expect(roles(key), key).not.toContain('service');
    }
    // The register is masked for everyone and never open to viewers or the deal team.
    for (const key of [
      `GET ${API_PREFIX}/wire-instructions`,
      `GET ${API_PREFIX}/wire-instructions/{id}`,
    ]) {
      expect(roles(key), key).not.toContain('viewer');
      expect(roles(key), key).not.toContain('deal_team');
      expect(roles(key), key).not.toContain('investor_relations');
    }
  });

  it('joins the OpenAPI document without a collision, spread into ROUTES', () => {
    // ROUTES already carries CONTROL_ROUTES (wave 2), so the document built from the default
    // table has one operation per route and counts nothing twice.
    const doc = buildOpenApi('0.1.0');
    const operations = Object.values(doc.paths).flatMap((p) => Object.keys(p));
    expect(operations.length).toBe(ROUTES.length);
    expect(operations.length).toBeGreaterThan(CONTROL_ROUTES.length);
    const propose = doc.paths[`${API_PREFIX}/wire-instructions`]?.post as {
      'x-roles': string[];
      requestBody: unknown;
      responses: Record<string, unknown>;
    };
    expect(propose['x-roles']).toEqual(['operations']);
    expect(propose.requestBody).toBeDefined();
    expect(Object.keys(propose.responses)).toContain('201');
    for (const route of CONTROL_ROUTES)
      expect(doc.paths[route.path]?.[route.method.toLowerCase()], route.path).toBeDefined();
  });
});

describe('re-exports', () => {
  it('serves the moved valuation and notice bodies from simulated.ts as the same objects', () => {
    expect(simulated.valuationCommandBody).toBe(controls.valuationCommandBody);
    expect(simulated.valuationCreateBody).toBe(controls.valuationCreateBody);
    expect(simulated.capitalNoticeCommandBody).toBe(controls.capitalNoticeCommandBody);
    expect(simulated.valuationCommand).toBe(controls.valuationCommand);
    expect(simulated.capitalNoticeCommand).toBe(controls.capitalNoticeCommand);
    const bodies = new Map(
      ROUTES.filter((r) => r.method === 'POST').map((r) => [r.path, r.body] as const),
    );
    expect(bodies.get(`${API_PREFIX}/valuations`)).toBe(controls.valuationCreateBody);
    expect(bodies.get(`${API_PREFIX}/valuations/{id}/commands`)).toBe(
      controls.valuationCommandBody,
    );
    expect(bodies.get(`${API_PREFIX}/capital-notices/{id}/commands`)).toBe(
      controls.capitalNoticeCommandBody,
    );
  });
});

describe('lock text', () => {
  it('sorts keys, writes no spaces and encodes values as JSON', () => {
    expect(canonicalJson({ b: 'two', a: 1, c: 'x"y' })).toBe('{"a":1,"b":"two","c":"x\\"y"}');
    expect(canonicalJson({})).toBe('{}');
  });

  it('covers only the five lock fields, whatever else the row carries', () => {
    const text = valuationLockText({
      investmentId: INV,
      periodEnd: '2025-06-30',
      version: 2,
      method: 'Last round',
      fairValue: '1250000.00',
    });
    expect(text).toBe(
      `{"fairValue":"1250000.00","investmentId":"${INV}","method":"Last round","periodEnd":"2025-06-30","version":2}`,
    );
    const row = valuationRow.parse({
      id: ID,
      investmentId: INV,
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
      vehicleName: 'Co-Invest Fund I',
      dealType: 'deal_type.co_invest_equity',
      periodEnd: '2025-06-30',
      quarterEnd: '2025-06-30',
      version: 2,
      state: 'OpsPrepared',
      method: 'Last round',
      fairValue: '1250000.00',
      priorFairValue: '1000000.00',
      changePct: '0.25',
      lockHash: null,
      preparedBy: 'Ops One',
      dealTeamApprovedBy: null,
      approvedBy: null,
      approvedAt: null,
      reopenReason: null,
      rowVersion: 3,
    });
    expect(valuationLockText(row)).toBe(text);
    // The digest the API (node:crypto) and the preview (SubtleCrypto) must both produce: pinned,
    // so a change to the text or the field set is a deliberate one.
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      '828c4e9f8fcd8423b76d5e175ca857a1cca0302e9789faf1b56eb3c68700cc1f',
    );
    // A changed value changes the text, so the hash no longer verifies.
    expect(valuationLockText({ ...row, fairValue: '1250000.01' })).not.toBe(text);
  });
});

describe('valuation bodies', () => {
  it('creates a Draft with optional method inputs and refuses an unknown field', () => {
    const body = {
      investmentId: INV,
      periodEnd: '2025-06-30',
      method: 'DCF',
      fairValue: '1200.50',
    };
    expect(parses(valuationCreateBody, body)).toBe(true);
    expect(
      parses(valuationCreateBody, { ...body, inputs: { discountRate: 0.12, basis: 'LTM' } }),
    ).toBe(true);
    expect(parses(valuationCreateBody, { ...body, fairValue: 1200.5 })).not.toBe(true);
    expect(parses(valuationCreateBody, { ...body, inputs: { flag: true } })).not.toBe(true);
    expect(parses(valuationCreateBody, { ...body, extra: 1 })).not.toBe(true);
  });

  it('takes a command with an optional reason of at least three characters', () => {
    expect(parses(valuationCommandBody, { command: 'prepare' })).toBe(true);
    expect(
      parses(valuationCommandBody, { command: 'sendBack', reason: 'needs a second look' }),
    ).toBe(true);
    expect(parses(valuationCommandBody, { command: 'sendBack', reason: 'no' })).not.toBe(true);
    expect(parses(valuationCommandBody, { command: 'approve' })).not.toBe(true);
  });

  it('batches only the two approvals over 1 to 100 ids', () => {
    expect(parses(valuationBatchCommandBody, { command: 'lock', ids: [ID] })).toBe(true);
    expect(
      parses(valuationBatchCommandBody, { command: 'dealTeamApprove', ids: [ID], reason: 'batch' }),
    ).toBe(true);
    expect(parses(valuationBatchCommandBody, { command: 'lock', ids: [] })).not.toBe(true);
    expect(parses(valuationBatchCommandBody, { command: 'reopen', ids: [ID] })).not.toBe(true);
    expect(
      parses(valuationBatchCommandBody, { command: 'lock', ids: Array<string>(101).fill(ID) }),
    ).not.toBe(true);
    expect(
      parses(valuationBatchResult, {
        results: [
          { id: ID, ok: true, state: 'Locked' },
          {
            id: INV,
            ok: false,
            problem: { status: 422, code: 'workflow-precondition', detail: 'the preparer' },
          },
        ],
      }),
    ).toBe(true);
  });

  it('reads the detail with the approval trail, open change requests and the lock text', () => {
    const row = {
      id: ID,
      investmentId: INV,
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
      vehicleName: 'Co-Invest Fund I',
      dealType: 'deal_type.co_invest_equity',
      periodEnd: '2025-06-30',
      quarterEnd: '2025-06-30',
      version: 1,
      state: 'OpsPrepared',
      method: 'Last round',
      fairValue: '1250000.00',
      priorFairValue: null,
      changePct: null,
      lockHash: 'a'.repeat(64),
      preparedBy: 'Ops One',
      dealTeamApprovedBy: null,
      approvedBy: null,
      approvedAt: null,
      reopenReason: null,
      rowVersion: 2,
    };
    const detail = {
      ...row,
      approvals: [
        {
          id: USER_B,
          step: 'ops_prepared',
          decision: 'approve',
          actorId: USER_A,
          actorName: 'Ops One',
          at: AT,
          reason: null,
        },
      ],
      openChangeRequests: [],
      lockText: valuationLockText(row),
    };
    expect(parses(valuationDetail, detail)).toBe(true);
    expect(
      parses(valuationDetail, { ...detail, approvals: [{ ...detail.approvals[0], step: 'x' }] }),
    ).not.toBe(true);
    expect(parses(valuationDetail, row)).not.toBe(true);
  });
});

describe('capital notice bodies', () => {
  it('takes each command with an optional reason, the ticket draft with its date and amount', () => {
    expect(parses(capitalNoticeCommandBody, { command: 'review' })).toBe(true);
    expect(parses(capitalNoticeCommandBody, { command: 'approveTicket', reason: 'checked' })).toBe(
      true,
    );
    expect(parses(capitalNoticeCommandBody, { command: 'draftTicket' })).toBe(true);
    expect(
      parses(capitalNoticeCommandBody, {
        command: 'draftTicket',
        fundingDate: '2025-11-03',
        amount: '250000.00',
      }),
    ).toBe(true);
    expect(parses(capitalNoticeCommandBody, { command: 'draftTicket', amount: '0' })).not.toBe(
      true,
    );
    expect(parses(capitalNoticeCommandBody, { command: 'draftTicket', amount: '-5' })).not.toBe(
      true,
    );
    expect(
      parses(capitalNoticeCommandBody, { command: 'review', fundingDate: '2025-11-03' }),
    ).not.toBe(true);
  });

  it('sends a ticket back on a wire change with or without a reason (the service fires it too) and refuses an unknown command', () => {
    expect(
      parses(capitalNoticeCommandBody, { command: 'wireChanged', reason: 'new version proposed' }),
    ).toBe(true);
    expect(parses(capitalNoticeCommandBody, { command: 'wireChanged' })).toBe(true);
    expect(parses(capitalNoticeCommandBody, { command: 'wireChanged', reason: 'no' })).not.toBe(
      true,
    );
    expect(parses(capitalNoticeCommandBody, { command: 'release' })).not.toBe(true);
  });

  it('extends the recorded notice detail with the ticket, the active instruction and the alerts', () => {
    const base = {
      id: NOTICE,
      noticeType: 'notice_type.capital_call',
      state: 'TicketDrafted',
      vehicleId: VEHICLE,
      vehicleName: 'Co-Invest Fund I',
      investmentId: INV,
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
      commitmentId: null,
      sponsorFundName: 'Harborlight Fund IV',
      issueDate: '2025-10-15',
      dueDate: '2025-10-22',
      amount: '250000.00',
      currency: 'USD',
      split: { investment: '250000.00' },
      scenarioTag: 'wire_change',
      settledAmount: null,
      daysToDue: 2,
      rowVersion: 1,
      cashFlows: [],
      wireChangeHold: { until: '2025-10-25', holdDays: 5 },
      notes: [],
    };
    // The ticket, the active instruction and the alerts are part of the detail itself (M16).
    expect(parses(capitalNoticeDetail, base)).not.toBe(true);
    expect(capitalNoticeControlDetail).toBe(capitalNoticeDetail);
    const wire = {
      id: WIRE,
      counterparty: { kind: 'sponsor_fund', id: FUND, name: 'Harborlight Fund IV' },
      version: 1,
      state: 'Verified',
      bankDetailsMasked: 'Harbor Street Bank ****4821',
      proposedBy: opsOne,
      proposedAt: AT,
      sourceNote: null,
      callback: { by: headOne, at: AT, numberSource: 'prior_instruction', result: 'confirmed' },
      verifiedAt: AT,
      rejectionReason: null,
      active: true,
      rowVersion: 1,
    };
    const ticket = {
      id: ID,
      capitalNoticeId: NOTICE,
      amount: '250000.00',
      currency: 'USD',
      fundingDate: '2025-10-22',
      preparedBy: opsOne,
      preparedAt: AT,
      approvedBy: null,
      approvedAt: null,
      wireInstruction: null,
      state: 'Drafted',
      release: { allowed: false, blockers: ['changed_within_hold', 'unverified_instruction'] },
      rowVersion: 1,
    };
    const detail = {
      ...base,
      ticket,
      activeWireInstruction: wire,
      alerts: ['wire_changed', 'urgency_language', 'due_within_two_business_days'],
    };
    expect(parses(capitalNoticeControlDetail, detail)).toBe(true);
    expect(parses(capitalNoticeControlDetail, base)).not.toBe(true);
    expect(
      parses(capitalNoticeControlDetail, { ...detail, alerts: ['look_alike_domain'] }),
    ).not.toBe(true);
    expect(
      parses(tradeTicketRow, { ...ticket, release: { allowed: false, blockers: ['late'] } }),
    ).not.toBe(true);
  });
});

describe('wire instruction bodies', () => {
  const details = {
    bankName: 'Harbor Street Bank',
    accountName: 'Harborlight Fund IV',
    accountNumber: '1234567890',
    routingCode: '021000021',
    reference: 'HF4 CALL 7',
  };

  it('proposes a version for exactly one counterparty with typed bank details', () => {
    const body = {
      sponsorFundId: FUND,
      counterpartyName: 'Harborlight Fund IV',
      bankDetails: details,
    };
    expect(parses(wireInstructionProposeBody, body)).toBe(true);
    expect(
      parses(wireInstructionProposeBody, {
        investmentId: INV,
        counterpartyName: 'Saltmarsh Holdings',
        bankDetails: details,
        sourceNote: 'Confirmed on the sponsor call',
      }),
    ).toBe(true);
    expect(parses(wireInstructionProposeBody, { ...body, investmentId: INV })).not.toBe(true);
    expect(
      parses(wireInstructionProposeBody, { counterpartyName: 'X', bankDetails: details }),
    ).not.toBe(true);
    expect(parses(wireInstructionProposeBody, { ...body, extra: 1 })).not.toBe(true);
  });

  it('accepts only digits, 6 to 20 of them, for the account number and routing code', () => {
    expect(parses(bankDetails, details)).toBe(true);
    expect(parses(bankDetails, { ...details, reference: undefined })).toBe(true);
    for (const bad of ['12345', '1'.repeat(21), '12 34 56', 'GB29NWBK601613', '']) {
      expect(parses(bankDetails, { ...details, accountNumber: bad }), bad).not.toBe(true);
      expect(parses(bankDetails, { ...details, routingCode: bad }), bad).not.toBe(true);
    }
    expect(parses(bankDetails, { ...details, bankName: '' })).not.toBe(true);
    expect(parses(bankDetails, { ...details, iban: 'x' })).not.toBe(true);
  });

  it('records a confirming callback to verify, and a reason to reject', () => {
    expect(
      parses(wireInstructionCommandBody, {
        command: 'verify',
        callbackNumberSource: 'prior_instruction',
        callbackResult: 'confirmed',
      }),
    ).toBe(true);
    expect(
      parses(wireInstructionCommandBody, {
        command: 'verify',
        callbackNumberSource: 'known_contact',
        callbackResult: 'not_confirmed',
      }),
    ).not.toBe(true);
    expect(parses(wireInstructionCommandBody, { command: 'verify' })).not.toBe(true);
    expect(
      parses(wireInstructionCommandBody, {
        command: 'verify',
        callbackNumberSource: 'the_notice',
        callbackResult: 'confirmed',
      }),
    ).not.toBe(true);
    expect(
      parses(wireInstructionCommandBody, { command: 'reject', reason: 'number did not answer' }),
    ).toBe(true);
    expect(
      parses(wireInstructionCommandBody, {
        command: 'reject',
        callbackNumberSource: 'sponsor_website',
        callbackResult: 'not_confirmed',
        reason: 'the contact did not recognise the account',
      }),
    ).toBe(true);
    expect(
      parses(wireInstructionCommandBody, {
        command: 'reject',
        callbackResult: 'confirmed',
        reason: 'x'.repeat(10),
      }),
    ).not.toBe(true);
    expect(parses(wireInstructionCommandBody, { command: 'reject' })).not.toBe(true);
    expect(parses(wireInstructionCommandBody, { command: 'supersede' })).not.toBe(true);
  });

  it('reads the detail with bank details in clear or null, never a bare string', () => {
    const row = {
      id: WIRE,
      counterparty: { kind: 'investment', id: INV, name: 'Saltmarsh Holdings' },
      version: 2,
      state: 'Proposed',
      bankDetailsMasked: 'Northline Trust ****7788',
      proposedBy: opsOne,
      proposedAt: AT,
      sourceNote: 'Changed instructions received in the notice',
      callback: null,
      verifiedAt: null,
      rejectionReason: null,
      active: false,
      rowVersion: 1,
    };
    expect(parses(wireInstructionDetail, { ...row, bankDetails: details })).toBe(true);
    expect(parses(wireInstructionDetail, { ...row, bankDetails: null })).toBe(true);
    expect(parses(wireInstructionDetail, row)).not.toBe(true);
    expect(parses(wireInstructionDetail, { ...row, bankDetails: '1234567890' })).not.toBe(true);
    expect(parses(wireInstructionDetail, { ...row, bankDetails: null, version: 0 })).not.toBe(true);
  });
});

describe('change request bodies', () => {
  it('creates from the one form with a bounded summary and plain details', () => {
    const body = {
      investmentId: INV,
      changeType: 'change_type.add_on_acquisition',
      effectiveDate: '2025-09-15',
      summary: 'Add-on acquisition of a regional competitor closed',
    };
    const parsed = changeRequestCreateBody.parse(body);
    expect(parsed.details).toEqual({});
    expect(
      parses(changeRequestCreateBody, { ...body, details: { target: 'Coastline Services' } }),
    ).toBe(true);
    expect(parses(changeRequestCreateBody, { ...body, changeType: 'add_on_acquisition' })).not.toBe(
      true,
    );
    expect(parses(changeRequestCreateBody, { ...body, summary: 'ok' })).not.toBe(true);
    expect(parses(changeRequestCreateBody, { ...body, summary: 'x'.repeat(201) })).not.toBe(true);
    expect(parses(changeRequestCreateBody, { ...body, details: { n: 1 } })).not.toBe(true);
  });

  it('routes to an owner, applies in a quarter end and rejects with a reason', () => {
    expect(parses(changeRequestCommandBody, { command: 'route', ownerId: USER_A })).toBe(true);
    expect(parses(changeRequestCommandBody, { command: 'route' })).not.toBe(true);
    expect(parses(changeRequestCommandBody, { command: 'start' })).toBe(true);
    expect(parses(changeRequestCommandBody, { command: 'start', reason: 'x' })).not.toBe(true);
    expect(
      parses(changeRequestCommandBody, { command: 'apply', appliedPeriod: '2025-09-30' }),
    ).toBe(true);
    expect(
      parses(changeRequestCommandBody, { command: 'apply', appliedPeriod: '2025-09-15' }),
    ).not.toBe(true);
    expect(parses(changeRequestCommandBody, { command: 'apply' })).not.toBe(true);
    expect(
      parses(changeRequestCommandBody, { command: 'reject', reason: 'duplicate request' }),
    ).toBe(true);
    expect(parses(changeRequestCommandBody, { command: 'reject' })).not.toBe(true);
  });

  it('runs the quarter-end check for a quarter end only and reports the unapplied requests', () => {
    expect(parses(quarterEndCheckBody, { periodEnd: '2025-09-30' })).toBe(true);
    expect(parses(quarterEndCheckBody, { periodEnd: '2025-09-29' })).not.toBe(true);
    const row = {
      id: ID,
      investmentId: INV,
      investmentName: 'Saltmarsh Holdings',
      changeType: 'change_type.recapitalization',
      effectiveDate: '2025-08-01',
      summary: 'Dividend recapitalization completed',
      details: { newDebt: '40000000.00' },
      owner: opsOne,
      submittedBy: headOne,
      state: 'InProgress',
      appliedPeriod: null,
      appliedBy: null,
      rejectionReason: null,
      createdAt: AT,
      rowVersion: 2,
    };
    expect(parses(changeRequestRow, row)).toBe(true);
    expect(
      parses(quarterEndCheckResult, {
        periodEnd: '2025-09-30',
        unapplied: [row],
        exceptionsOpened: 1,
      }),
    ).toBe(true);
    expect(parses(changeRequestRow, { ...row, state: 'Open' })).not.toBe(true);
  });
});

describe('opportunity bodies', () => {
  it('creates at Sourced with taxonomy codes and a positive target', () => {
    const body = {
      name: 'Project Dune',
      companyName: 'Dunegrass Software',
      sponsorId: SPONSOR,
      dealType: 'deal_type.co_invest_equity',
      receivedDate: '2025-10-01',
    };
    expect(parses(opportunityCreateBody, body)).toBe(true);
    expect(
      parses(opportunityCreateBody, {
        ...body,
        sponsorFundId: FUND,
        sector: 'sector.software',
        geography: 'geography.north_america',
        targetCommitment: '15000000.00',
        source: 'Sponsor outreach',
      }),
    ).toBe(true);
    expect(parses(opportunityCreateBody, { ...body, dealType: 'co_invest_equity' })).not.toBe(true);
    expect(parses(opportunityCreateBody, { ...body, targetCommitment: '0' })).not.toBe(true);
    expect(parses(opportunityCreateBody, { ...body, stage: 'Closed' })).not.toBe(true);
  });

  it('advances with the close date and commitment together, passes with a reason code, reopens with a reason', () => {
    expect(parses(opportunityCommandBody, { command: 'advance' })).toBe(true);
    expect(
      parses(opportunityCommandBody, { command: 'advance', reason: 'override: tax memo late' }),
    ).toBe(true);
    expect(
      parses(opportunityCommandBody, {
        command: 'advance',
        closeDate: '2025-12-15',
        commitmentAmount: '15000000.00',
      }),
    ).toBe(true);
    expect(parses(opportunityCommandBody, { command: 'advance', closeDate: '2025-12-15' })).toEqual(
      ['commitmentAmount: A close date and a commitment amount are given together'],
    );
    expect(
      parses(opportunityCommandBody, { command: 'advance', commitmentAmount: '15000000.00' }),
    ).toEqual(['closeDate: A close date and a commitment amount are given together']);
    expect(
      parses(opportunityCommandBody, { command: 'pass', passReasonCode: 'pass_reason.valuation' }),
    ).toBe(true);
    expect(
      parses(opportunityCommandBody, {
        command: 'pass',
        passReasonCode: 'pass_reason.timing',
        note: 'Process moved faster than our IC calendar',
      }),
    ).toBe(true);
    expect(parses(opportunityCommandBody, { command: 'pass' })).not.toBe(true);
    expect(
      parses(opportunityCommandBody, { command: 'pass', passReasonCode: 'valuation' }),
    ).not.toBe(true);
    expect(parses(opportunityCommandBody, { command: 'reopen', reason: 'sponsor came back' })).toBe(
      true,
    );
    expect(parses(opportunityCommandBody, { command: 'reopen' })).not.toBe(true);
  });

  it('takes diligence tasks, their commands, IC decisions and the allocation list', () => {
    expect(
      parses(diligenceTaskCreateBody, {
        workstream: 'diligence_workstream.legal',
        title: 'Review of the shareholder agreement',
        requiredForIc: true,
      }),
    ).toBe(true);
    expect(
      parses(diligenceTaskCreateBody, {
        workstream: 'legal',
        title: 'x',
        requiredForIc: false,
      }),
    ).not.toBe(true);
    expect(parses(diligenceTaskCommandBody, { command: 'complete' })).toBe(true);
    expect(parses(diligenceTaskCommandBody, { command: 'complete', evidenceDocumentId: DOC })).toBe(
      true,
    );
    expect(
      parses(diligenceTaskCommandBody, { command: 'waive', reason: 'covered by the QoE' }),
    ).toBe(true);
    expect(parses(diligenceTaskCommandBody, { command: 'waive' })).not.toBe(true);
    expect(parses(diligenceTaskCommandBody, { command: 'reopen' })).toBe(true);
    expect(
      parses(icDecisionBody, {
        decisionDate: '2025-11-10',
        decision: 'approved',
        amount: '15000000.00',
        conditions: ['Key person clause confirmed'],
      }),
    ).toBe(true);
    expect(
      parses(icDecisionBody, { decisionDate: '2025-11-10', decision: 'approved', conditions: [] }),
    ).toBe(true);
    expect(
      parses(icDecisionBody, { decisionDate: '2025-11-10', decision: 'maybe', conditions: [] }),
    ).not.toBe(true);
    expect(
      parses(allocationsPutBody, {
        allocations: [
          { vehicleId: VEHICLE, requested: '10000000.00', received: '10000000.00' },
          { vehicleId: VEHICLE, clientId: CLIENT, requested: '5000000.00' },
        ],
      }),
    ).toBe(true);
    expect(
      parses(allocationsPutBody, { allocations: [{ vehicleId: VEHICLE, requested: '-1' }] }),
    ).not.toBe(true);
    expect(
      parses(allocationsPutBody, { allocations: [{ vehicleId: VEHICLE, requested: '0' }] }),
    ).toBe(true);
  });

  it('reads the detail with its gates and the closing summary', () => {
    const detail = {
      id: ID,
      name: 'Project Dune',
      companyName: 'Dunegrass Software',
      sponsor: { id: SPONSOR, name: 'Kelpwood Capital' },
      sponsorFund: { id: FUND, name: 'Kelpwood Fund III' },
      dealType: 'deal_type.co_invest_equity',
      sector: 'sector.software',
      geography: 'geography.north_america',
      stage: 'Closing',
      owner: opsOne,
      receivedDate: '2025-06-01',
      targetCommitment: '15000000.00',
      currency: 'USD',
      daysInStage: 12,
      passReasonCode: null,
      investmentId: null,
      rowVersion: 9,
      source: 'Sponsor outreach',
      passNote: null,
      stageHistory: [
        {
          fromStage: null,
          toStage: 'Sourced',
          command: 'create',
          reason: null,
          changedBy: opsOne,
          changedAt: AT,
        },
        {
          fromStage: 'Sourced',
          toStage: 'Screening',
          command: 'advance',
          reason: null,
          changedBy: opsOne,
          changedAt: AT,
        },
      ],
      diligenceTasks: [
        {
          id: USER_A,
          workstream: 'diligence_workstream.financial',
          title: 'Quality of earnings review',
          owner: null,
          dueDate: '2025-09-01',
          status: 'done',
          requiredForIc: true,
          evidenceDocumentId: null,
          waivedReason: null,
        },
      ],
      icDecisions: [
        {
          id: USER_B,
          decisionDate: '2025-11-10',
          decision: 'approved',
          amount: '15000000.00',
          conditions: [],
          recordedBy: headOne,
        },
      ],
      allocations: [
        {
          id: WIRE,
          vehicle: { id: VEHICLE, name: 'Co-Invest Fund I' },
          client: null,
          requested: '15000000.00',
          received: '15000000.00',
        },
      ],
      closing: {
        id: NOTICE,
        closeDate: '2025-12-15',
        commitmentAmount: '15000000.00',
        currency: 'USD',
        state: 'Open',
        opsConfirmedBy: null,
        opsConfirmedAt: null,
        itemsOpen: 1,
        itemsRequiredOpen: 1,
        allocationTieOut: {
          commitment: '15000000.00',
          allocated: '15000000.00',
          difference: '0',
          tiedOut: true,
        },
      },
      gates: {
        diligence: { requiredOpen: 0, ok: true },
        icDecision: { ok: true },
        closing: { checklistComplete: false, allocationTiedOut: true, ok: false },
      },
    };
    expect(parses(opportunityDetail, detail)).toBe(true);
    expect(parses(opportunityDetail, { ...detail, closing: null })).toBe(true);
    expect(parses(opportunityDetail, { ...detail, stage: 'Won' })).not.toBe(true);
    expect(parses(opportunityDetail, { ...detail, gates: { diligence: { ok: true } } })).not.toBe(
      true,
    );
  });
});

describe('closing bodies', () => {
  it('receives an item with its document, waives with a reason, confirms, and changes the close date with a reason', () => {
    expect(parses(closingItemCommandBody, { command: 'receive', documentId: DOC })).toBe(true);
    expect(parses(closingItemCommandBody, { command: 'receive' })).not.toBe(true);
    expect(parses(closingItemCommandBody, { command: 'waive', reason: 'no side letter' })).toBe(
      true,
    );
    expect(parses(closingItemCommandBody, { command: 'waive' })).not.toBe(true);
    expect(parses(closingItemCommandBody, { command: 'reopen' })).toBe(true);
    expect(parses(closingCommandBody, { command: 'confirm' })).toBe(true);
    expect(parses(closingCommandBody, { command: 'confirm', reason: 'x' })).not.toBe(true);
    expect(
      parses(closingCommandBody, {
        command: 'changeCloseDate',
        closeDate: '2025-12-18',
        reason: 'funds flow moved three days',
      }),
    ).toBe(true);
    expect(
      parses(closingCommandBody, { command: 'changeCloseDate', closeDate: '2025-12-18' }),
    ).not.toBe(true);
    expect(
      parses(closingCommandBody, { command: 'changeCloseDate', reason: 'x'.repeat(5) }),
    ).not.toBe(true);
  });

  it('adds a legal term as structured values and confirms it', () => {
    expect(
      parses(legalTermCreateBody, {
        termType: 'legal_term_type.management_fee',
        value: { ratePct: 1.5, basis: 'committed', stepDown: true },
        sourceDocumentId: DOC,
      }),
    ).toBe(true);
    expect(
      parses(legalTermCreateBody, { termType: 'management_fee', value: { ratePct: 1.5 } }),
    ).not.toBe(true);
    expect(
      parses(legalTermCreateBody, {
        termType: 'legal_term_type.mfn',
        value: { elections: ['a'] },
      }),
    ).not.toBe(true);
    expect(parses(legalTermCommandBody, { command: 'confirm' })).toBe(true);
    expect(parses(legalTermCommandBody, { command: 'delete' })).not.toBe(true);
  });

  it('reads the detail with the checklist, legal terms, allocations and the tie-out', () => {
    const detail = {
      id: NOTICE,
      closeDate: '2025-12-15',
      commitmentAmount: '15000000.00',
      currency: 'USD',
      state: 'OpsConfirmed',
      opsConfirmedBy: opsOne,
      opsConfirmedAt: AT,
      itemsOpen: 0,
      itemsRequiredOpen: 0,
      allocationTieOut: {
        commitment: '15000000.00',
        allocated: '15000000.00',
        difference: '0',
        tiedOut: true,
      },
      opportunityId: ID,
      investmentId: INV,
      items: [
        {
          id: USER_A,
          itemCode: 'signed_documents',
          label: 'Signed subscription and transaction documents',
          required: true,
          documentId: DOC,
          status: 'received',
          waivedReason: null,
        },
        {
          id: USER_B,
          itemCode: 'side_letter',
          label: 'Side letter',
          required: false,
          documentId: null,
          status: 'waived',
          waivedReason: 'No side letter on this deal',
        },
      ],
      legalTerms: [
        {
          id: WIRE,
          termType: 'legal_term_type.key_person',
          value: { persons: 2, suspensionOnDeparture: true },
          sourceDocumentId: DOC,
          status: 'confirmed',
          confirmedBy: opsOne,
        },
      ],
      allocations: [],
      rowVersion: 4,
    };
    expect(parses(closingDetail, detail)).toBe(true);
    expect(parses(closingDetail, { ...detail, state: 'Closed' })).not.toBe(true);
    expect(
      parses(closingDetail, { ...detail, items: [{ ...detail.items[0], status: 'lost' }] }),
    ).not.toBe(true);
  });
});
