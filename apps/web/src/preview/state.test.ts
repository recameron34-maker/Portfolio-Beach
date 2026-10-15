import { describe, expect, it, vi } from 'vitest';
import { Recordings } from './fixtures.js';
import { getKey, isApiPath, isPublicPath } from './keys.js';
import {
  createPreviewState,
  ensureNotices,
  ensureValuations,
  newUuid,
  personFor,
  resetPreviewState,
  seedValuations,
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
    resetPreviewState(state);
    expect(state.valuations).toBeNull();
    expect(state.notices).toBeNull();
    expect(state.flags.size).toBe(0);
    expect(state.intakeFiles.size).toBe(0);
    expect(state.weeklyFiles.size).toBe(0);
    expect(state.lookthroughRuns.size).toBe(0);
    expect(state.exceptions.size).toBe(0);
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
