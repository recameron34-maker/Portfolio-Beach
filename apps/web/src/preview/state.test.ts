import { describe, expect, it, vi } from 'vitest';
import { Recordings } from './fixtures.js';
import { getKey, isApiPath, isPublicPath } from './keys.js';
import {
  createPreviewState,
  ensureClosings,
  ensureNotices,
  ensureValuations,
  eventKey,
  newUuid,
  nextEventKey,
  personFor,
  resetPreviewState,
  seedChangeRequests,
  seedEventOrder,
  seedOpportunities,
  seedTickets,
  seedValuations,
  seedWires,
  userIdsFor,
} from './state.js';
import { IDS, USERS, buildWorld } from './test-fixtures.js';

const actor = (u: (typeof USERS)[keyof typeof USERS]) => ({ ...u });

describe('request keys', () => {
  it('keys a GET path with its sorted query and tells public and API paths apart', () => {
    expect(getKey('u', '/api/v1/valuations?limit=200&investmentId=x')).toBe(
      'u|GET /api/v1/valuations?investmentId=x&limit=200',
    );
    expect(isPublicPath('/health/ready')).toBe(true);
    expect(isPublicPath('/api/v1/auth/mock-users')).toBe(true);
    expect(isPublicPath('/api/v1/auth/me')).toBe(false);
    expect(isApiPath('/assets/index.js')).toBe(false);
    expect(isApiPath('/api/v1/flags')).toBe(true);
  });
});

describe('who did it: display names and user ids', () => {
  const users = [
    { externalId: 'a', userId: 'id-a', displayName: 'Shared Name', roles: ['operations'] },
    { externalId: 'b', userId: 'id-b', displayName: 'Shared Name', roles: ['deal_team'] },
    { externalId: 'c', userId: 'id-c', displayName: 'Only C', roles: ['approver'] },
  ];

  it('maps a recorded display name, or an id, back to the users behind it', () => {
    expect(userIdsFor(users, 'Only C')).toEqual(['id-c']);
    expect(userIdsFor(users, 'id-b')).toEqual(['id-b']);
    expect(userIdsFor(users, 'Shared Name')).toEqual(['id-a', 'id-b']);
    expect(userIdsFor(users, 'Nobody')).toEqual([]);
    expect(userIdsFor(users, null)).toEqual([]);
  });

  it('treats any namesake as the person for segregation of duties', () => {
    const ids = userIdsFor(users, 'Shared Name');
    expect(personFor(ids, { ...users[1]!, roles: ['deal_team'] })).toBe('id-b');
    expect(personFor(ids, { ...users[2]!, roles: ['approver'] })).toBe('id-a');
    expect(personFor([], actor(USERS.head))).toBeNull();
  });
});

describe('seeding from the recordings', () => {
  it('seeds every row any user can see, starting from the largest list', () => {
    const { fixtures, valuations } = buildWorld();
    const seeded = seedValuations(new Recordings(fixtures));
    expect([...seeded.keys()].sort()).toEqual(valuations.map((v) => v.id).sort());
    const prepared = seeded.get(IDS.valuation.OpsPrepared);
    expect(prepared?.preparedByIds).toEqual([USERS.all.userId]);
    expect(prepared?.changed).toBe(false);
  });

  it('seeds the register, the tickets, the change requests, the pipeline and the closings from every recorded view', () => {
    const recordings = new Recordings(buildWorld().fixtures);
    const wires = seedWires(recordings);
    expect(wires.size).toBe(5);
    expect(wires.get(IDS.wire.Verified)).toMatchObject({
      origin: 'recorded',
      changed: false,
      bankDetails: null,
    });
    // The walled notice's ticket is seeded from the wall member's view; its release is judged when served.
    const tickets = seedTickets(recordings);
    expect([...tickets.keys()].sort()).toEqual(
      [IDS.ticket.drafted, IDS.ticket.funded, IDS.ticket.walled].sort(),
    );
    expect(tickets.get(IDS.ticket.funded)?.wireInstructionId).toBe(IDS.wire.verifiedFund2);
    expect(seedChangeRequests(recordings).size).toBe(4);
    const opportunities = seedOpportunities(recordings);
    expect(opportunities.size).toBe(7);
    const closingOpen = opportunities.get(IDS.opportunity.closingOpen);
    expect(closingOpen?.closingId).toBe(IDS.closing.open);
    expect(closingOpen?.tasks).toHaveLength(6);
    expect(closingOpen?.decisions).toHaveLength(1);
    // The order of events the gates read: the recorded history in order, the tasks and the
    // decision after it (the recorded gates are open and nothing is carried over).
    expect(closingOpen?.order.history).toEqual([1, 2, 3, 4, 5, 6, 7].map(eventKey));
    expect(closingOpen?.order.count).toBe(8);
    expect(new Set(closingOpen?.order.tasks.values())).toEqual(new Set([eventKey(8)]));
    expect([...(closingOpen?.order.decisions.values() ?? [])]).toEqual([eventKey(8)]);
    // The reopened deal: the recorded gate carries four tasks over and does not read the first
    // round's approval, so those tasks and that decision predate the history.
    const reopened = opportunities.get(IDS.opportunity.reopened);
    expect(reopened?.order.history).toHaveLength(11);
    expect(
      reopened?.tasks
        .filter((t) => reopened.order.tasks.get(t.id) === eventKey(0))
        .map((t) => t.requiredForIc),
    ).toEqual([true, true, true, true]);
    expect(
      reopened?.tasks.filter((t) => reopened.order.tasks.get(t.id) === eventKey(12)).length,
    ).toBe((reopened?.tasks.length ?? 0) - 4);
    expect([...(reopened?.order.decisions.values() ?? [])]).toEqual([eventKey(0)]);
    expect(opportunities.get(IDS.opportunity.walled)?.stageHistory.map((h) => h.toStage)).toEqual([
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
    ]);
    const state = createPreviewState();
    const closings = ensureClosings(state, recordings);
    expect([...closings.keys()].sort()).toEqual([IDS.closing.open, IDS.closing.confirmed].sort());
    expect(closings.get(IDS.closing.open)?.items.map((i) => i.itemCode)).toHaveLength(7);
    expect(state.opportunities).not.toBeNull();
    resetPreviewState(state);
    expect(state.wires).toBeNull();
    expect(state.tickets).toBeNull();
    expect(state.changeRequests).toBeNull();
    expect(state.opportunities).toBeNull();
    expect(state.closings).toBeNull();
    expect(state.investments.size).toBe(0);
  });

  it('keeps the order of a deal in keys that sort as the events happened, and seeds it from the recorded gates', () => {
    expect(eventKey(0) < eventKey(9)).toBe(true);
    expect(eventKey(9) < eventKey(10)).toBe(true);
    expect(eventKey(99) < eventKey(100)).toBe(true);
    // A deal with no recorded detail has no child rows to order.
    const empty = seedEventOrder(undefined);
    expect(empty).toEqual({ count: 1, history: [], tasks: new Map(), decisions: new Map() });
    expect(nextEventKey(empty)).toBe(eventKey(2));
    expect(empty.count).toBe(2);

    const [reopened] = buildWorld().opportunities.filter((o) => o.id === IDS.opportunity.reopened);
    if (reopened === undefined) throw new Error('the world has no reopened deal');
    // The recorded gate is closed with a deferred decision latest: it is of the current round.
    const deferred = seedEventOrder({
      ...reopened,
      icDecisions: [{ ...reopened.icDecisions[0]!, decision: 'deferred' }],
    });
    expect([...deferred.decisions.values()]).toEqual([eventKey(12)]);
    // Fewer carried over than done: the first in list order are the ones carried over.
    const two = seedEventOrder({
      ...reopened,
      gates: { ...reopened.gates, diligence: { requiredOpen: 0, ok: true, carriedOver: 2 } },
    });
    const required = reopened.diligenceTasks.filter((t) => t.requiredForIc);
    expect(required.map((t) => two.tasks.get(t.id))).toEqual([
      eventKey(0),
      eventKey(0),
      eventKey(12),
      eventKey(12),
    ]);
  });

  it('starts empty while the lists are recorded as 501, and reset forgets the seed', () => {
    const recorded = new Recordings(buildWorld().fixtures);
    const pending = new Recordings(buildWorld({ workflowEndpoints: 'not-implemented' }).fixtures);
    expect(seedValuations(pending).size).toBe(0);
    const state = createPreviewState();
    expect(ensureNotices(state, pending).size).toBe(0);
    expect(ensureValuations(state, recorded).size).toBeGreaterThan(0);
    state.flags.set('ai.extraction', true);
    const header = {
      fileName: 'x',
      contentHash: 'h',
      receivedAt: '2025-07-01T00:00:00.000Z',
      receivedBy: 'Test Operator',
      rowCount: 0,
      fileFindings: [],
      rowVersion: 1,
      rows: [],
    };
    state.intakeFiles.set('a', {
      ...header,
      id: 'a',
      source: 'accounting',
      templateSignature: null,
    });
    state.weeklyFiles.set('w', { ...header, id: 'w' });
    state.lookthroughRuns.set('l', { ...header, id: 'l', asOf: '2025-06-30' });
    state.exceptions.set('x', {
      id: 'x',
      source: 'accounting_import',
      entity: 'stg.intake_row',
      entityId: 'r',
      ruleId: 'TIE-01',
      expected: null,
      actual: null,
      severity: 'exception_severity.high',
      ownerId: null,
      ownerName: null,
      state: 'open',
      externalTicket: null,
      candidates: [],
      createdAt: '2025-07-01T00:00:00.000Z',
      updatedAt: '2025-07-01T00:00:00.000Z',
      rowVersion: 1,
      context: { intakeFileId: 'a', intakeFileName: 'x', rowNo: 1, investmentId: null },
    });
    state.expectedDocuments.set('e', {
      id: 'e',
      investmentId: null,
      sponsorFundId: 'fund',
      periodEnd: '2025-06-30',
      docType: 'doc_type.capital_account_statement',
      dueDate: '2025-08-14',
      receivedDocumentId: null,
      createdAt: '2025-07-01T00:00:00.000Z',
    });
    state.outlooks.set('i', {
      investmentId: 'i',
      outlook: 'full',
      horizonMonths: 6,
      note: null,
      setById: 'u',
      setBy: 'Test Deal Lead',
      setAt: '2025-07-01T00:00:00.000Z',
      rowVersion: 1,
    });
    resetPreviewState(state);
    expect(state.valuations).toBeNull();
    expect(state.notices).toBeNull();
    expect(state.flags.size).toBe(0);
    expect(state.intakeFiles.size).toBe(0);
    expect(state.weeklyFiles.size).toBe(0);
    expect(state.lookthroughRuns.size).toBe(0);
    expect(state.exceptions.size).toBe(0);
    expect(state.expectedDocuments.size).toBe(0);
    expect(state.outlooks.size).toBe(0);
    for (const map of [
      state.documents,
      state.batches,
      state.runs,
      state.values,
      state.promotedQuarters,
    ])
      expect(map.size).toBe(0);
  });
});

describe('ids for simulated records', () => {
  it('uses crypto.randomUUID on a secure page and builds a version 4 UUID elsewhere', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newUuid()).toMatch(v4);
    const real = globalThis.crypto;
    // A page opened from a file or over plain http has getRandomValues but no randomUUID.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => newUuid()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(v4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
