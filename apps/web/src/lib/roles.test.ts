import { describe, expect, it } from 'vitest';
import { ALL_CLIENT_ROLES, appRole } from '@pb/contracts';
import {
  ROLE_WORDS,
  SEES_ALL_CLIENTS,
  seesAllClients,
  userLabel,
  WHO_READS_EVERY_CLIENT,
} from './roles.js';

describe('users and roles in words', () => {
  it('names every role the user holds, in the order held', () => {
    expect(userLabel({ displayName: 'Dana Deal', roles: ['deal_team'] })).toBe(
      'Dana Deal (deal team)',
    );
    expect(
      userLabel({ displayName: 'Test Everyone', roles: ['investor_relations', 'platform_admin'] }),
    ).toBe('Test Everyone (investor relations, platform admin)');
  });

  it('has plain words, never a machine name, for every role in the contract', () => {
    for (const role of appRole.options) expect(ROLE_WORDS[role]).toMatch(/^[a-z]+( [a-z]+)*$/);
  });
});

describe('who reads every client (SEC-5.2)', () => {
  it('follows the one list in the contract: operations, the investment team and the auditor', () => {
    expect([...SEES_ALL_CLIENTS].sort()).toEqual([...ALL_CLIENT_ROLES].sort());
    for (const role of ALL_CLIENT_ROLES) expect(seesAllClients([role]), role).toBe(true);
    expect(seesAllClients(['deal_team'])).toBe(true);
    for (const role of ['viewer', 'investor_relations', 'platform_admin', 'service'] as const)
      expect(seesAllClients([role]), role).toBe(false);
  });

  it('says so in words every page shares, naming each of those roles', () => {
    expect(WHO_READS_EVERY_CLIENT).toBe(
      'operations, the investment team (the deal team and approvers) and auditors',
    );
    // Each role of the list is in the sentence, by its plain words (an approver as "approvers").
    for (const role of ALL_CLIENT_ROLES) expect(WHO_READS_EVERY_CLIENT).toContain(ROLE_WORDS[role]);
  });
});
