import { describe, expect, it } from 'vitest';
import { classify, findings, parseDenyList } from './licenses.mjs';

const DENY = parseDenyList('GPL-2.0, GPL-3.0, AGPL-3.0');

describe('the licence deny list', () => {
  it('reads the list as the workflow writes it', () => {
    expect(DENY).toEqual(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0']);
    expect(parseDenyList('')).toEqual([]);
  });

  it('denies a listed licence in every spelling of its version', () => {
    for (const id of [
      'GPL-3.0',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
      'GPL-3.0+',
      'gpl-3.0',
      'GPL-2.0-only',
      'AGPL-3.0-or-later',
    ])
      expect(classify(id, DENY), id).toBe('denied');
  });

  it('does not mistake another licence for a listed one', () => {
    for (const id of [
      'MIT',
      'Apache-2.0',
      'LGPL-3.0-or-later',
      'LGPL-2.1',
      'MPL-2.0',
      'BlueOak-1.0.0',
      '0BSD',
    ])
      expect(classify(id, DENY), id).toBe('ok');
  });

  it('follows the expression: a choice is free to take the other side, a sum is not', () => {
    expect(classify('(MIT OR GPL-3.0)', DENY)).toBe('ok');
    expect(classify('MIT OR Apache-2.0', DENY)).toBe('ok');
    expect(classify('MIT AND GPL-2.0', DENY)).toBe('denied');
    expect(classify('(GPL-2.0 OR GPL-3.0)', DENY)).toBe('denied');
    expect(classify('Apache-2.0 AND (MIT OR GPL-3.0)', DENY)).toBe('ok');
    expect(classify('Apache-2.0 AND (AGPL-3.0 OR GPL-3.0-only)', DENY)).toBe('denied');
    // An exception does not take the licence off the list.
    expect(classify('GPL-2.0-only WITH Classpath-exception-2.0', DENY)).toBe('denied');
    expect(classify('Apache-2.0 WITH LLVM-exception', DENY)).toBe('ok');
  });

  it('calls what it cannot read unknown, never ok', () => {
    for (const text of [
      '',
      'UNKNOWN',
      'UNLICENSED',
      'SEE LICENSE IN LICENSE.md',
      '(MIT OR',
      'MIT OR',
    ])
      expect(classify(text, DENY), text).toBe('unknown');
  });

  it('lists the packages behind each denied or unknown licence, by name', () => {
    const listing = {
      MIT: [{ name: 'b-lib', versions: ['1.0.0'], license: 'MIT' }],
      'GPL-3.0-only': [
        { name: 'z-tool', versions: ['2.1.0', '2.0.0'], license: 'GPL-3.0-only' },
        { name: 'a-tool', versions: ['0.3.0'], license: 'GPL-3.0-only' },
      ],
      Unknown: [{ name: 'mystery', versions: ['9.9.9'], license: 'Unknown' }],
      '(MIT OR GPL-3.0)': [{ name: 'either', versions: ['1.2.3'], license: '(MIT OR GPL-3.0)' }],
    };
    expect(findings(listing, DENY)).toEqual({
      packages: 5,
      denied: [
        { name: 'a-tool', versions: ['0.3.0'], license: 'GPL-3.0-only' },
        { name: 'z-tool', versions: ['2.0.0', '2.1.0'], license: 'GPL-3.0-only' },
      ],
      unknown: [{ name: 'mystery', versions: ['9.9.9'], license: 'Unknown' }],
    });
    expect(findings({}, DENY)).toEqual({ packages: 0, denied: [], unknown: [] });
  });
});
