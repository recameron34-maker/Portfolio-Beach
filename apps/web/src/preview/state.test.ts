import { describe, expect, it } from 'vitest';
import { Recordings } from './fixtures.js';
import { getKey, isApiPath, isPublicPath } from './keys.js';
import {
  createPreviewState,
  ensureNotices,
  ensureValuations,
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
    resetPreviewState(state);
    expect(state.valuations).toBeNull();
    expect(state.notices).toBeNull();
    expect(state.flags.size).toBe(0);
  });
});
