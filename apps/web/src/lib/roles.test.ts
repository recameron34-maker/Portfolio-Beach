import { describe, expect, it } from 'vitest';
import { appRole } from '@pb/contracts';
import { ROLE_WORDS, userLabel } from './roles.js';

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
