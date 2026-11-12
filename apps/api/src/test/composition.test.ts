import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProductionGuardError } from '@pb/adapters';
import { DEV_FIELD_KEY, FieldCipher } from '@pb/db';
import { FIELD_KEY_OFFENDER, fieldCipherFor } from '../common/fieldCipher.js';
import { loadMockUsers } from '../composition.js';

/** A users file in a scratch folder, shaped as tools/synthetic writes it (with keys the loader ignores). */
const usersFile = (users: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'pb-users-')), 'dataset.json');
  writeFileSync(path, JSON.stringify({ asOf: '2025-06-30', users }));
  return path;
};
const user = (roles: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '10000000-0000-4000-8000-000000000001',
  externalId: 'viewer.one',
  displayName: 'Viewer One',
  email: 'viewer@portfolio-beach.example',
  roles,
  ...extra,
});

describe('loadMockUsers: only application roles reach the identity adapter (SEC-5.3)', () => {
  it('answers no users for a missing file', () => {
    expect(loadMockUsers(join(tmpdir(), 'pb-users-missing', 'dataset.json'))).toEqual([]);
  });

  it('loads users whose roles are application roles, with their entitlements', () => {
    const path = usersFile([
      user(['viewer']),
      user(['investor_relations'], {
        id: '10000000-0000-4000-8000-000000000005',
        externalId: 'ir.one',
        displayName: 'IR One',
        clientIds: ['40000000-0000-4000-8000-000000000001'],
      }),
    ]);
    expect(loadMockUsers(path)).toEqual([
      {
        id: '10000000-0000-4000-8000-000000000001',
        externalId: 'viewer.one',
        displayName: 'Viewer One',
        roles: ['viewer'],
        clientIds: [],
      },
      {
        id: '10000000-0000-4000-8000-000000000005',
        externalId: 'ir.one',
        displayName: 'IR One',
        roles: ['investor_relations'],
        clientIds: ['40000000-0000-4000-8000-000000000001'],
      },
    ]);
  });

  it('refuses a role string that would smuggle the service role past the role array', () => {
    for (const roles of [['viewer,service'], ['service,viewer'], ['viewer', 'deal_team,service']]) {
      expect(() => loadMockUsers(usersFile([user(roles)]))).toThrow(/not valid/);
    }
  });

  it('refuses roles that are not application roles, and a users block of the wrong shape', () => {
    for (const roles of [['editor'], [''], ['Viewer'], 'viewer', [null], [1]]) {
      expect(() => loadMockUsers(usersFile([user(roles)]))).toThrow(/not valid/);
    }
    expect(() => loadMockUsers(usersFile([{ externalId: 'x', roles: ['viewer'] }]))).toThrow(
      /not valid/,
    );
    expect(() => loadMockUsers(usersFile({ viewer: ['viewer'] }))).toThrow(/not valid/);
  });

  it('names the path of the bad value in the error, never the value itself', () => {
    const marker = 'MARKER-NEVER-ECHOED-0002';
    let message = '';
    try {
      loadMockUsers(usersFile([user([`viewer,${marker}`])]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('users.0.roles.0');
    expect(message).not.toContain(marker);
  });
});

describe('fieldCipherFor: the wire register key and the production guard (SEC-12.2, SEC-17.6)', () => {
  const REAL_KEY = 'a'.repeat(32) + 'B'.repeat(32);

  it('refuses to start in production without PB_FIELD_KEY_HEX, naming the prototype key', () => {
    let caught: unknown;
    try {
      fieldCipherFor('production', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionGuardError);
    expect((caught as ProductionGuardError).offenders).toEqual([FIELD_KEY_OFFENDER]);
    expect((caught as Error).message).toContain('refusing to start in production');
    expect(() => fieldCipherFor('production', { PB_FIELD_KEY_HEX: '' })).toThrow(
      ProductionGuardError,
    );
  });

  it('uses the environment key when set, in every environment, and never echoes it', () => {
    for (const env of ['production', 'development', 'test']) {
      const cipher = fieldCipherFor(env, { PB_FIELD_KEY_HEX: REAL_KEY });
      const text = cipher.encrypt('synthetic 123456');
      expect(cipher.decrypt(text)).toBe('synthetic 123456');
      // A different key cannot read it: the prototype key is not in play.
      expect(() => new FieldCipher(DEV_FIELD_KEY).decrypt(text)).toThrow();
    }
  });

  it('falls back to the documented prototype key outside production only', () => {
    for (const env of ['development', 'test']) {
      const cipher = fieldCipherFor(env, {});
      expect(new FieldCipher(DEV_FIELD_KEY).decrypt(cipher.encrypt('round trip'))).toBe(
        'round trip',
      );
    }
  });

  it('refuses a malformed key everywhere without naming its value', () => {
    const marker = 'MARKER-NEVER-ECHOED-0003';
    for (const env of ['production', 'development', 'test']) {
      let message = '';
      try {
        fieldCipherFor(env, { PB_FIELD_KEY_HEX: marker });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('PB_FIELD_KEY_HEX');
      expect(message).not.toContain(marker);
    }
  });
});
