import { syntheticDatasetSchema } from '@pb/db';
import { isNearMiss, normalizeName } from '@pb/validation';
import { describe, expect, it } from 'vitest';
import {
  ALIASES_PER_COMPANY_MAX,
  abbreviatedForm,
  aliasesOf,
  companyAliasesFor,
  shortenedForm,
} from './aliases.js';
import { generateDataset } from './generate.js';
import { Rng } from './prng.js';
import { verifyDataset } from './verify.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('company aliases (docs/03 section 5, docs/04 M1)', () => {
  it('gives about a third of the companies one or two aliases in a known form', () => {
    const companies = new Map(small.portfolioCompanies.map((c) => [c.id, c.name]));
    const aliased = new Set(small.companyAliases.map((a) => a.portfolioCompanyId));
    expect(aliased.size).toBeGreaterThan(0);
    expect(aliased.size / companies.size).toBeGreaterThanOrEqual(0.15);
    expect(aliased.size / companies.size).toBeLessThanOrEqual(0.55);
    for (const id of aliased) {
      const forms = aliasesOf(small, id);
      expect(forms.length).toBeGreaterThanOrEqual(1);
      expect(forms.length).toBeLessThanOrEqual(ALIASES_PER_COMPANY_MAX);
      const name = companies.get(id) ?? '';
      for (const alias of forms)
        expect([shortenedForm(name), abbreviatedForm(name)]).toContain(alias);
    }
    for (const a of small.companyAliases) {
      expect(a.id).toMatch(UUID);
      expect(companies.has(a.portfolioCompanyId)).toBe(true);
    }
    expect(new Set(small.companyAliases.map((a) => a.id)).size).toBe(small.companyAliases.length);
  });

  it.each([42, 7, 14])(
    'never equals or near-misses another name on record, by the linking rule (seed %i)',
    (seed) => {
      const dataset = seed === 42 ? small : generateDataset({ profile: 'small', seed });
      const names = [
        ...dataset.portfolioCompanies.map((c) => c.name),
        ...dataset.matchGuards.flatMap((g) => [g.nameA, g.nameB]),
      ];
      const guarded = new Set(dataset.matchGuards.flatMap((g) => [g.nameA, g.nameB]));
      const companyName = new Map(dataset.portfolioCompanies.map((c) => [c.id, c.name]));
      const aliases = dataset.companyAliases;
      expect(aliases.length).toBeGreaterThan(0);
      for (const [i, a] of aliases.entries()) {
        for (const n of names) {
          expect(normalizeName(a.alias)).not.toBe(normalizeName(n));
          expect(isNearMiss(a.alias, n), `${a.alias} vs ${n}`).toBe(false);
        }
        for (const other of aliases.slice(i + 1)) {
          expect(normalizeName(a.alias)).not.toBe(normalizeName(other.alias));
          expect(isNearMiss(a.alias, other.alias), `${a.alias} vs ${other.alias}`).toBe(false);
        }
        expect(guarded.has(companyName.get(a.portfolioCompanyId) ?? '')).toBe(false);
      }
      // The first active equity position outside the wall and off the guard list is always aliased.
      const walledId = dataset.scenarios.walled_deal?.[0];
      const anchor = dataset.investments
        .filter((i) => i.isActive && i.dealType !== 'deal_type.private_credit' && i.id !== walledId)
        .find((i) => !guarded.has(companyName.get(i.portfolioCompanyId) ?? ''));
      expect(anchor).toBeDefined();
      expect(aliasesOf(dataset, anchor?.portfolioCompanyId ?? '').length).toBeGreaterThan(0);
    },
  );

  it('is deterministic, draws from its own stream, and still loads under the seed contract', () => {
    const again = generateDataset({ profile: 'small', seed: 42 });
    expect(again.companyAliases).toEqual(small.companyAliases);
    // Adding aliases moved no other seeded value: the fixed expectations of the other tests hold
    // (the accounting export's period end off the quarter, the outlooks' timestamp), and the
    // contract that predates the alias table still parses the dataset.
    expect(verifyDataset(small).problems).toEqual([]);
    const parsed = syntheticDatasetSchema.safeParse(small);
    expect(parsed.success).toBe(true);
  });

  it('builds the two forms and declines a one-word name', () => {
    expect(shortenedForm('Meridian Data Partners')).toBe('Meridian Data');
    expect(abbreviatedForm('Meridian Data Partners')).toBe('MDP');
    expect(shortenedForm('Quill')).toBeNull();
    expect(abbreviatedForm('Quill')).toBeNull();
  });

  it('aliases a company named in `always` whatever the draw, but never a guarded one', () => {
    const companies = [
      { id: 'a', name: 'Meridian Data Partners' },
      { id: 'b', name: 'Keystone Outsourcing Inc' },
      { id: 'c', name: 'Keystone Outsourcing Co' },
    ];
    const guards = [{ nameA: 'Keystone Outsourcing Inc', nameB: 'Keystone Outsourcing Co' }];
    const out = companyAliasesFor(companies, guards, new Rng(1), new Set(['a', 'b']));
    expect(out.some((a) => a.portfolioCompanyId === 'a')).toBe(true);
    expect(out.some((a) => a.portfolioCompanyId === 'b')).toBe(false);
    expect(out.some((a) => a.portfolioCompanyId === 'c')).toBe(false);
    // The same rng state gives the same aliases; another seed may choose differently.
    expect(companyAliasesFor(companies, guards, new Rng(1), new Set(['a', 'b']))).toEqual(out);
  });

  it('drops a form that would near-miss another company, keeping the other form', () => {
    const companies = [
      { id: 'a', name: 'Summit Services Co' },
      { id: 'b', name: 'Summit Services Inc' },
    ];
    const out = companyAliasesFor(companies, [], new Rng(3), new Set(['a', 'b']));
    // "Summit Services" would be a near miss of both names, so neither company gets it.
    expect(out.map((a) => a.alias)).not.toContain('Summit Services');
    for (const a of out) expect(['SSC', 'SSI']).toContain(a.alias);
  });

  it("never takes a stem two names share: a prefix of another name, or another company's form", () => {
    // "Summit Services" is no near miss of either name, but a prefix of both: an exact match on
    // it would link an ambiguous name to whichever company drew first.
    const companies = [
      { id: 'a', name: 'Summit Services Group' },
      { id: 'b', name: 'Summit Services Partners' },
    ];
    const out = companyAliasesFor(companies, [], new Rng(3), new Set(['a', 'b']));
    expect(out.map((a) => a.alias)).not.toContain('Summit Services');
    // Only the abbreviations are left, and the second near-misses the first, so one company has
    // an alias and neither has the stem.
    expect(out.length).toBeGreaterThan(0);
    for (const a of out) expect(['SSG', 'SSP']).toContain(a.alias);
    // An abbreviation two companies share is nobody's alias either, whatever the draw.
    const initials = [
      { id: 'a', name: 'Marlowe Services Inc' },
      { id: 'b', name: 'Meridian Systems Inc' },
    ];
    for (const seed of [1, 2, 3]) {
      const forms = companyAliasesFor(initials, [], new Rng(seed), new Set(['a', 'b'])).map(
        (a) => a.alias,
      );
      expect(forms).not.toContain('MSI');
      expect(forms.sort()).toEqual(['Marlowe Services', 'Meridian Systems']);
    }
  });

  it.each([42, 7, 14])(
    'is never a stem two names share on the default profile (seed %i)',
    (seed) => {
      const dataset = generateDataset({ profile: 'default', seed });
      const stems = dataset.portfolioCompanies.map((c) => ({
        id: c.id,
        name: c.name,
        normalized: normalizeName(c.name),
        forms: [shortenedForm(c.name), abbreviatedForm(c.name)].map((f) => normalizeName(f ?? '')),
      }));
      expect(dataset.companyAliases.length).toBeGreaterThan(0);
      for (const a of dataset.companyAliases) {
        const wanted = normalizeName(a.alias);
        const shared = stems
          .filter(
            (s) =>
              s.id !== a.portfolioCompanyId &&
              (s.normalized.startsWith(wanted) || s.forms.includes(wanted)),
          )
          .map((s) => s.name);
        expect(shared, `${a.alias} is a stem of`).toEqual([]);
      }
    },
  );
});
