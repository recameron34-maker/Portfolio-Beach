import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AiError } from './errors.js';
import { loadExtractionSchemas } from './schema.js';
import type { ExtractionOutput, ExtractedField } from './schema.js';
import {
  EXTRACTION_RULES,
  EXTRACTION_RULE_IDS,
  boundsFrom,
  extractionSettingsFrom,
  highlightStyleFrom,
  normalizeWhitespace,
  validateExtraction,
} from './validate.js';
import type { ExtractionValidation, ValidateExtractionOptions } from './validate.js';

const root = new URL('../../../', import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const schema = loadExtractionSchemas(read('config/extraction_schema.json')).quarterly_financials!;
const style = highlightStyleFrom(read('config/style.json'));
const BANNED = style.bannedPhrases[0]!;
const EM_DASH = String.fromCharCode(0x2014);

/** Thresholds as config carries them (the API reads them strictly; tests state them). */
const bounds = boundsFrom({
  unitSanityBoundsUsd: { revenueMin: 1000000, revenueMax: 50000000000 },
});
const settings = extractionSettingsFrom({
  extraction: { confidenceFlagBelow: 0.8, quoteMaxChars: 150 },
});

const PAGES = [
  'Harbor Growth Fund III\nQuarterly Report\nFor the quarter ended June 30, 2025\nHarbor Logistics Group (INV-0021)',
  'Financial summary (USD millions)\nLTM revenue   125.40\nLTM EBITDA 31.20\nNet debt 88.00\nCash 12.30\nHeadcount 1,240\nSponsor ownership 42.5%',
  `Footnotes ${'x'.repeat(200)}`,
];

function field(patch: Partial<ExtractedField>): ExtractedField {
  return { value: null, unit: null, page: null, quote: null, confidence: '0.95', ...patch };
}

function cleanOutput(): ExtractionOutput {
  const fields: Record<string, ExtractedField> = Object.fromEntries(
    schema.fields.map((f) => [f.key, field({})]),
  );
  fields.period_end = field({
    value: '2025-06-30',
    unit: 'DATE',
    page: 1,
    quote: 'quarter ended June 30, 2025',
  });
  fields.revenue_ltm = field({
    value: '125.40',
    unit: 'USD_M',
    page: 2,
    quote: 'LTM revenue 125.40',
  });
  fields.ebitda_ltm = field({ value: '31.20', unit: 'USD_M', page: 2, quote: 'LTM EBITDA 31.20' });
  fields.net_debt = field({ value: '88.00', unit: 'USD_M', page: 2, quote: 'Net debt 88.00' });
  fields.cash = field({ value: '12.30', unit: 'USD_M', page: 2, quote: 'Cash 12.30' });
  fields.headcount = field({ value: '1240', unit: 'COUNT', page: 2, quote: 'Headcount 1,240' });
  fields.sponsor_ownership_pct = field({
    value: '0.425',
    unit: 'PCT',
    page: 2,
    quote: 'Sponsor ownership 42.5%',
  });
  return {
    fields,
    highlights: [
      'LTM revenue grew 8% to 125.4 million.',
      'Performance was driven by volume growth in the core lanes.',
      'Net debt fell to 88 million on free cash flow.',
    ],
    commentary: 'Revenue and EBITDA grew in the quarter; leverage fell.',
  };
}

function run(
  output: ExtractionOutput,
  overrides: Partial<ValidateExtractionOptions> = {},
): ExtractionValidation {
  return validateExtraction(output, {
    schema,
    pageTexts: PAGES,
    bounds,
    style,
    ...settings,
    ...overrides,
  });
}

function rules(v: ExtractionValidation, key: string): string[] {
  return v.fields[key]!.findings.map((f) => f.ruleId);
}

describe('validateExtraction: a clean output', () => {
  it('is clean on every field, the highlights and the commentary', () => {
    const v = run(cleanOutput());
    expect(v.overall).toBe('clean');
    expect(v.highlights).toEqual([]);
    expect(v.commentary).toEqual([]);
    for (const f of schema.fields)
      expect(v.fields[f.key]).toEqual({ validationState: 'clean', findings: [] });
  });

  it('lists every rule id of the brief with a severity and a title', () => {
    expect([...EXTRACTION_RULE_IDS]).toEqual([
      'EXT-REQ-01',
      'EXT-UNIT-01',
      'EXT-UNIT-02',
      'EXT-CITE-01',
      'EXT-CITE-02',
      'EXT-CITE-03',
      'EXT-CONF-01',
      'EXT-DATE-01',
      'EXT-STYLE-01',
      'EXT-TEXT-01',
    ]);
    expect(
      Object.values(EXTRACTION_RULES)
        .filter((r) => r.severity === 'invalid')
        .map((r) => r.id),
    ).toEqual([
      'EXT-REQ-01',
      'EXT-UNIT-01',
      'EXT-CITE-01',
      'EXT-CITE-02',
      'EXT-CITE-03',
      'EXT-DATE-01',
    ]);
  });
});

describe('EXT-REQ-01 (required field missing)', () => {
  it('fails a required field with no value and passes an optional one', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm = field({});
    o.fields.cash = field({});
    const v = run(o);
    expect(rules(v, 'revenue_ltm')).toEqual(['EXT-REQ-01']);
    expect(v.fields.revenue_ltm!.validationState).toBe('invalid');
    expect(v.fields.revenue_ltm!.findings[0]!.message).toBe(
      'Revenue LTM is required but the document gave no value',
    );
    expect(v.fields.cash!.validationState).toBe('clean');
    expect(v.overall).toBe('invalid');
  });

  it('treats a key the output does not carry as missing', () => {
    const o = cleanOutput();
    delete o.fields.ebitda_ltm;
    delete o.fields.gross_debt;
    const v = run(o);
    expect(rules(v, 'ebitda_ltm')).toEqual(['EXT-REQ-01']);
    expect(v.fields.gross_debt!.validationState).toBe('clean');
  });
});

describe('EXT-UNIT-01 (unit not allowed for the kind)', () => {
  it('passes a money unit on a money field and fails PCT on money, USD on percent, and no unit at all', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm!.unit = 'PCT';
    o.fields.sponsor_ownership_pct!.unit = 'USD';
    o.fields.headcount!.unit = null;
    const v = run(o);
    expect(rules(v, 'ebitda_ltm')).toEqual([]);
    expect(rules(v, 'revenue_ltm')).toEqual(['EXT-UNIT-01']);
    expect(v.fields.revenue_ltm!.findings[0]!.message).toBe(
      'Revenue LTM carries unit PCT; a money field takes USD, USD_K, USD_M, USD_B',
    );
    expect(rules(v, 'sponsor_ownership_pct')).toEqual(['EXT-UNIT-01']);
    expect(rules(v, 'headcount')).toEqual(['EXT-UNIT-01']);
    expect(v.fields.headcount!.findings[0]!.message).toContain('carries unit none');
    expect(v.overall).toBe('invalid');
  });
});

describe('EXT-UNIT-02 (converted value outside bounds)', () => {
  it('passes 125.40 USD_M and flags 125.40 USD (millions read as dollars), never a field without bounds', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm!.unit = 'USD';
    o.fields.cash!.unit = 'USD';
    const v = run(o);
    expect(rules(v, 'ebitda_ltm')).toEqual([]);
    expect(rules(v, 'revenue_ltm')).toEqual(['EXT-UNIT-02']);
    expect(v.fields.revenue_ltm!.validationState).toBe('flagged');
    expect(v.fields.revenue_ltm!.findings[0]!.message).toBe(
      'Revenue LTM converts to 125.4 dollars, outside the revenue range 1000000 to 50000000000; check whether the unit is right',
    );
    expect(rules(v, 'cash')).toEqual([]);
    expect(v.overall).toBe('flagged');
  });

  it('gives EBITDA its own range when config has one and the revenue range otherwise', () => {
    expect(bounds.ebitda).toEqual(bounds.revenue);
    const own = boundsFrom({
      unitSanityBoundsUsd: {
        revenueMin: '1000000',
        revenueMax: '50000000000',
        ebitdaMin: '0',
        ebitdaMax: '100',
      },
    });
    expect(own.ebitda).toEqual({ minUsd: '0', maxUsd: '100' });
    const v = run(cleanOutput(), { bounds: own });
    expect(rules(v, 'ebitda_ltm')).toEqual(['EXT-UNIT-02']);
    expect(rules(v, 'revenue_ltm')).toEqual([]);
  });
});

describe('EXT-CITE-01 (a value without page or quote)', () => {
  it('passes a cited value and fails a missing page, a missing quote and a blank quote', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm!.page = null;
    o.fields.ebitda_ltm!.quote = null;
    o.fields.cash!.quote = '   ';
    const v = run(o);
    expect(rules(v, 'net_debt')).toEqual([]);
    for (const key of ['revenue_ltm', 'ebitda_ltm', 'cash']) {
      expect(rules(v, key)).toEqual(['EXT-CITE-01']);
      expect(v.fields[key]!.validationState).toBe('invalid');
    }
    expect(v.fields.revenue_ltm!.findings[0]!.message).toBe(
      'Revenue LTM has a value but no page or quote to support it',
    );
  });
});

describe('EXT-CITE-02 (quote not found on the cited page)', () => {
  it('normalizes whitespace, compares case-sensitively, and refuses a page the document does not have', () => {
    expect(normalizeWhitespace('  LTM \n\t revenue   125.40 ')).toBe('LTM revenue 125.40');
    const o = cleanOutput();
    o.fields.revenue_ltm!.quote = 'LTM\n  revenue\t125.40';
    o.fields.ebitda_ltm!.quote = 'ltm ebitda 31.20';
    o.fields.net_debt!.page = 1;
    o.fields.cash!.page = 9;
    const v = run(o);
    expect(rules(v, 'revenue_ltm')).toEqual([]);
    expect(rules(v, 'ebitda_ltm')).toEqual(['EXT-CITE-02']);
    expect(v.fields.ebitda_ltm!.findings[0]!.message).toBe(
      'EBITDA LTM: the quote was not found on page 2',
    );
    expect(rules(v, 'net_debt')).toEqual(['EXT-CITE-02']);
    expect(rules(v, 'cash')).toEqual(['EXT-CITE-02']);
    expect(v.fields.cash!.findings[0]!.message).toBe(
      'Cash cites page 9, but the document has 3 pages',
    );
    expect(v.overall).toBe('invalid');
  });
});

describe('EXT-CITE-03 (quote longer than the limit)', () => {
  it('passes 150 characters and fails 151, counted in characters', () => {
    const o = cleanOutput();
    o.fields.gross_debt = field({ value: '40.00', unit: 'USD_M', page: 3, quote: 'x'.repeat(150) });
    o.fields.capex_ltm = field({ value: '5.00', unit: 'USD_M', page: 3, quote: 'x'.repeat(151) });
    const v = run(o);
    expect(rules(v, 'gross_debt')).toEqual([]);
    expect(rules(v, 'capex_ltm')).toEqual(['EXT-CITE-03']);
    expect(v.fields.capex_ltm!.findings[0]!.message).toBe(
      'Capex LTM: the quote is 151 characters, over the limit of 150',
    );
    expect(v.fields.capex_ltm!.validationState).toBe('invalid');
  });

  it('reads the limit from config', () => {
    const o = cleanOutput();
    const v = run(o, { quoteMaxChars: 10 });
    expect(rules(v, 'revenue_ltm')).toEqual(['EXT-CITE-03']);
  });
});

describe('EXT-CONF-01 (confidence below the threshold)', () => {
  it('flags 0.79 and passes 0.8 at the configured threshold; flagged, never invalid', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm!.confidence = '0.79';
    o.fields.ebitda_ltm!.confidence = '0.8';
    const v = run(o);
    expect(rules(v, 'revenue_ltm')).toEqual(['EXT-CONF-01']);
    expect(v.fields.revenue_ltm!.validationState).toBe('flagged');
    expect(v.fields.revenue_ltm!.findings[0]!.message).toBe(
      'Revenue LTM has confidence 0.79, below the review threshold 0.8',
    );
    expect(rules(v, 'ebitda_ltm')).toEqual([]);
    expect(v.overall).toBe('flagged');
    expect(run(o, { confidenceFlagBelow: '0.5' }).overall).toBe('clean');
  });
});

describe('EXT-DATE-01 (period end not a quarter end or not the expected period)', () => {
  it('passes a quarter end that matches the expected period, fails a mid-quarter date and another quarter', () => {
    const o = cleanOutput();
    expect(rules(run(o, { expectedPeriodEnd: '2025-06-30' }), 'period_end')).toEqual([]);
    expect(rules(run(o, { expectedPeriodEnd: '2025-03-31' }), 'period_end')).toEqual([
      'EXT-DATE-01',
    ]);
    expect(
      run(o, { expectedPeriodEnd: '2025-03-31' }).fields.period_end!.findings[0]!.message,
    ).toBe('Period end is 2025-06-30, but the run expected 2025-03-31');
    o.fields.period_end!.value = '2025-06-15';
    const v = run(o);
    expect(rules(v, 'period_end')).toEqual(['EXT-DATE-01']);
    expect(v.fields.period_end!.findings[0]!.message).toBe(
      'Period end 2025-06-15 is not a quarter end',
    );
    expect(v.fields.period_end!.validationState).toBe('invalid');
  });
});

describe('EXT-STYLE-01 (highlights count, openings, banned phrases)', () => {
  it('flags a wrong bullet count', () => {
    const o = cleanOutput();
    o.highlights = o.highlights.slice(0, 2);
    const v = run(o);
    expect(v.highlights).toEqual([
      {
        ruleId: 'EXT-STYLE-01',
        message: 'The document type asks for 3 highlight bullets; 2 were given',
      },
    ]);
    expect(v.overall).toBe('flagged');
    expect(Object.values(v.fields).every((f) => f.validationState === 'clean')).toBe(true);
  });

  it('flags a bullet that does not open as config requires', () => {
    const o = cleanOutput();
    o.highlights[1] = 'Volume growth drove performance.';
    const v = run(o);
    expect(v.highlights).toEqual([
      {
        ruleId: 'EXT-STYLE-01',
        message: 'Highlight 2 does not open with "Performance was driven by"',
      },
    ]);
  });

  it('flags a banned phrase in a highlight or the commentary, case-insensitively', () => {
    const o = cleanOutput();
    o.highlights[2] = `Net debt fell on ${BANNED.toUpperCase()} execution.`;
    o.commentary = `A quarter of ${BANNED}.`;
    const v = run(o);
    expect(v.highlights).toEqual([
      { ruleId: 'EXT-STYLE-01', message: `Highlight 3 contains the banned phrase "${BANNED}"` },
    ]);
    expect(v.commentary).toEqual([
      { ruleId: 'EXT-STYLE-01', message: `The commentary contains the banned phrase "${BANNED}"` },
    ]);
    expect(v.overall).toBe('flagged');
  });
});

describe('EXT-TEXT-01 (an em dash in a highlight or the commentary)', () => {
  it('flags the em dash and passes ordinary punctuation', () => {
    const o = cleanOutput();
    o.highlights[0] = `LTM revenue grew 8% ${EM_DASH} to 125.4 million.`;
    o.commentary = `Leverage fell ${EM_DASH} again.`;
    const v = run(o);
    expect(v.highlights).toEqual([
      { ruleId: 'EXT-TEXT-01', message: 'Highlight 1 contains an em dash' },
    ]);
    expect(v.commentary).toEqual([
      { ruleId: 'EXT-TEXT-01', message: 'The commentary contains an em dash' },
    ]);
    o.highlights[0] = 'LTM revenue grew 8%, to 125.4 million: a record (unaudited).';
    o.commentary = null;
    expect(run(o).highlights).toEqual([]);
    expect(run(o).commentary).toEqual([]);
  });
});

describe('overall state and messages', () => {
  it('is invalid when any field is invalid even if others are only flagged, and never names a person', () => {
    const o = cleanOutput();
    o.fields.revenue_ltm!.confidence = '0.1';
    o.fields.ebitda_ltm!.page = null;
    o.highlights = [];
    const v = run(o);
    expect(v.overall).toBe('invalid');
    const messages = [
      ...Object.values(v.fields).flatMap((f) => f.findings),
      ...v.highlights,
      ...v.commentary,
    ].map((f) => f.message);
    expect(messages.length).toBeGreaterThan(2);
    for (const m of messages) expect(m).not.toMatch(/\b(you|your|reviewer|analyst)\b/i);
  });
});

describe('config readers', () => {
  it('refuse a missing key as an AiError invalid_config naming it', () => {
    for (const bad of [
      () => boundsFrom({}),
      () => boundsFrom({ unitSanityBoundsUsd: { revenueMin: 1 } }),
      () => extractionSettingsFrom({ extraction: { quoteMaxChars: 150 } }),
      () =>
        extractionSettingsFrom({ extraction: { confidenceFlagBelow: '0.8', quoteMaxChars: -1 } }),
      () => highlightStyleFrom({ highlights: { bannedPhrases: [] } }),
      () => highlightStyleFrom({ highlights: { requiredOpenings: { a: 'x' }, bannedPhrases: [] } }),
    ]) {
      expect(bad).toThrow(AiError);
      try {
        bad();
      } catch (error) {
        expect((error as AiError).code).toBe('invalid_config');
        expect((error as AiError).message).toMatch(/missing a usable/);
      }
    }
  });

  it('read decimals as plain digits and the style file as shipped', () => {
    expect(settings).toEqual({ confidenceFlagBelow: '0.8', quoteMaxChars: 150 });
    expect(bounds.revenue).toEqual({ minUsd: '1000000', maxUsd: '50000000000' });
    expect(style.requiredOpenings).toEqual({
      '1': 'LTM revenue',
      '2': 'Performance was driven by',
    });
    expect(style.bannedPhrases.length).toBeGreaterThan(0);
  });
});
