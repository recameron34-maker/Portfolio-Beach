import { afterEach, describe, expect, it } from 'vitest';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../lib/format.js';
import { codeWords, plainWords } from './plain-words.js';

describe('plain words', () => {
  afterEach(clearTaxonomyLabels);

  it('drops the controls, documents, sections and switch keys a sentence cites', () => {
    expect(plainWords('Kill switch for AI extraction calls (SEC-8.10)')).toBe(
      'Kill switch for AI extraction calls',
    );
    expect(
      plainWords('Opens the closing record (section 12) with the close date and commitment given.'),
    ).toBe('Opens the closing record with the close date and commitment given.');
    expect(plainWords('AI extraction is switched off (ai.extraction)')).toBe(
      'AI extraction is switched off',
    );
    expect(plainWords('Release is held until Jul 31, 2025 (SEC-12.3).')).toBe(
      'Release is held until Jul 31, 2025.',
    );
  });

  it('names a configuration file in words, or drops it when it stands alone in brackets', () => {
    expect(
      plainWords(
        'The sector label is not in config/lookthrough_mapping.json; the taxonomy is never guessed',
      ),
    ).toBe('The sector label is not in the look-through mapping; the taxonomy is never guessed');
    expect(plainWords('Late after 15 days (config/definitions.json documents).')).toBe(
      'Late after 15 days.',
    );
  });

  it('leaves every other word and bracket as it came', () => {
    for (const text of [
      'Short by $0.5M (two lines)',
      'Covers sections of the report (all of them)',
      'Healthcare (sector.healthcare)',
      'Error E42 (schema).',
    ])
      expect(plainWords(text)).toBe(text);
  });

  it('says a taxonomy code by its label, and a mapped label without its code', () => {
    registerTaxonomyLabels([{ code: 'sector.energy_transition', label: 'Energy transition' }]);
    expect(codeWords('sector.energy_transition')).toBe('Energy transition');
    expect(codeWords('doc_type.other')).toBe('Other');
    expect(codeWords('vehicle_type.co_invest_fund')).toBe('Co invest fund');
    expect(codeWords('Healthcare (sector.healthcare)')).toBe('Healthcare');
    expect(codeWords('suggested doc_type.other below the threshold')).toBe(
      'suggested Other below the threshold',
    );
  });

  it("keeps the term a provider's label was mapped to when the two read differently", () => {
    registerTaxonomyLabels([
      { code: 'sector.software', label: 'Software' },
      { code: 'sector.energy_transition', label: 'Energy transition' },
      { code: 'sector.healthcare', label: 'Healthcare' },
      { code: 'geography.other', label: 'Other' },
      { code: 'geography.north_america', label: 'North America' },
    ]);
    // The label was compared as this term: dropping the code must not drop what it meant.
    expect(codeWords('Technology (sector.software)')).toBe('Technology (Software)');
    expect(codeWords('Energy (sector.energy_transition)')).toBe('Energy (Energy transition)');
    expect(codeWords('Rest of World (geography.other)')).toBe('Rest of World (Other)');
    // The same words twice say nothing: the bracket goes, whatever the capitals or spacing.
    expect(codeWords('Healthcare (sector.healthcare)')).toBe('Healthcare');
    expect(codeWords('north  america (geography.north_america)')).toBe('north  america');
    // Never a code on the page, in or out of the bracket.
    expect(codeWords('sector.software (sector.software)')).toBe('Software');
  });

  it('never adds a unit or touches a figure, a name or a file', () => {
    for (const value of [
      '20000000.00',
      'Meridian Data Partner',
      'extract.csv',
      'a position on record',
    ])
      expect(codeWords(value)).toBe(value);
  });
});
