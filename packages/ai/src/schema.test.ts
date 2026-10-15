import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AiError } from './errors.js';
import {
  BOUNDS_KINDS,
  TARGET_COLUMNS,
  classifierOutputSchema,
  loadExtractionSchemas,
  outputSchemaFor,
} from './schema.js';
import type { ExtractionOutput } from './schema.js';

const root = new URL('../../../', import.meta.url);
const CONFIG: unknown = JSON.parse(
  readFileSync(new URL('config/extraction_schema.json', root), 'utf8'),
);

function configWith(mutate: (schema: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(CONFIG)) as {
    schemas: Record<string, Record<string, unknown>>;
  };
  mutate(copy.schemas.quarterly_financials!);
  return copy;
}

function field(
  key: string,
  patch: Record<string, unknown>,
): (schema: Record<string, unknown>) => void {
  return (schema) => {
    const fields = schema.fields as Record<string, unknown>[];
    const target = fields.find((f) => f.key === key)!;
    Object.assign(target, patch);
  };
}

describe('loadExtractionSchemas (config/extraction_schema.json)', () => {
  it('reads the quarterly schema with its 15 fields in order', () => {
    const schemas = loadExtractionSchemas(CONFIG);
    const q = schemas.quarterly_financials!;
    expect(q.id).toBe('quarterly_financials');
    expect(q.docType).toBe('doc_type.quarterly_financials');
    expect(q.promptId).toBe('quarterly_extraction');
    expect(q.fields.map((f) => f.key)).toEqual([
      'period_end',
      'revenue_ltm',
      'ebitda_ltm',
      'revenue_ltm_prior_year',
      'ebitda_ltm_prior_year',
      'enterprise_value',
      'net_debt',
      'cash',
      'total_equity',
      'gross_debt',
      'capex_ltm',
      'sponsor_ownership_pct',
      'fund_fair_value',
      'fund_cost',
      'headcount',
    ]);
    expect(q.fields.filter((f) => f.required).map((f) => f.key)).toEqual([
      'period_end',
      'revenue_ltm',
      'ebitda_ltm',
    ]);
    expect(q.fields.filter((f) => f.target !== null).map((f) => f.target)).toEqual([
      'revenue_ltm',
      'ebitda_ltm',
      'ev',
      'net_debt',
      'cash',
      'total_equity',
    ]);
    expect(q.fields.find((f) => f.key === 'sponsor_ownership_pct')?.kind).toBe('percent');
    expect(q.fields.find((f) => f.key === 'headcount')?.kind).toBe('count');
    expect(q.highlights.bullets).toBe(3);
    expect(q.commentary).toBe(true);
    expect(TARGET_COLUMNS).toEqual([
      'revenue_ltm',
      'ebitda_ltm',
      'ev',
      'net_debt',
      'cash',
      'total_equity',
    ]);
    expect(BOUNDS_KINDS).toEqual(['revenue', 'ebitda']);
  });

  it('refuses an unknown kind, target or bounds, naming the path', () => {
    expect(() => loadExtractionSchemas(configWith(field('cash', { kind: 'float' })))).toThrow(
      /schemas\.quarterly_financials\.fields\.7\.kind/,
    );
    expect(() => loadExtractionSchemas(configWith(field('cash', { target: 'nav' })))).toThrow(
      /fields\.7\.target/,
    );
    expect(() => loadExtractionSchemas(configWith(field('cash', { bounds: 'capex' })))).toThrow(
      /fields\.7\.bounds/,
    );
  });

  it('refuses a duplicate key, a duplicate target, and bounds or a target on a field that is not money', () => {
    expect(() => loadExtractionSchemas(configWith(field('cash', { key: 'net_debt' })))).toThrow(
      /key net_debt is listed twice/,
    );
    expect(() => loadExtractionSchemas(configWith(field('cash', { target: 'net_debt' })))).toThrow(
      /target net_debt is listed twice/,
    );
    expect(() => loadExtractionSchemas(configWith(field('headcount', { target: 'cash' })))).toThrow(
      /only a money field can have a target/,
    );
    expect(() =>
      loadExtractionSchemas(configWith(field('period_end', { bounds: 'revenue' }))),
    ).toThrow(/only a money field can have bounds/);
  });

  it('refuses an unknown prompt id, an unknown doc type, an extra key and a missing block, as an AiError invalid_config', () => {
    expect(() => loadExtractionSchemas(configWith((s) => (s.promptId = 'nope')))).toThrow(
      /promptId/,
    );
    expect(() => loadExtractionSchemas(configWith((s) => (s.docType = 'doc_type.memo')))).toThrow(
      /docType/,
    );
    expect(() => loadExtractionSchemas(configWith((s) => (s.extra = 1)))).toThrow(
      /quarterly_financials/,
    );
    try {
      loadExtractionSchemas({});
    } catch (error) {
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('invalid_config');
      expect((error as AiError).message).toMatch(/schemas/);
    }
  });
});

describe('outputSchemaFor', () => {
  const schema = loadExtractionSchemas(CONFIG).quarterly_financials!;
  const output = outputSchemaFor(schema);
  const clean = (): ExtractionOutput => ({
    fields: Object.fromEntries(
      schema.fields.map((f) => [
        f.key,
        { value: null, unit: null, page: null, quote: null, confidence: '0.9' },
      ]),
    ),
    highlights: [],
    commentary: null,
  });

  it('accepts an output with every field, decimal text values and known units', () => {
    const o = clean();
    o.fields.period_end = {
      value: '2025-06-30',
      unit: 'DATE',
      page: 1,
      quote: 'q',
      confidence: '1',
    };
    o.fields.revenue_ltm = {
      value: '12.50',
      unit: 'USD_M',
      page: 2,
      quote: 'q',
      confidence: '0.95',
    };
    o.fields.sponsor_ownership_pct = {
      value: '0.4250',
      unit: 'PCT',
      page: 2,
      quote: 'q',
      confidence: '1.0',
    };
    o.fields.headcount = { value: '1234', unit: 'COUNT', page: 3, quote: 'q', confidence: '0' };
    expect(output.parse(o)).toEqual(o);
  });

  it('refuses a float where decimal text belongs, an exponent, a non-integer count and a bad date', () => {
    const o = clean();
    o.fields.revenue_ltm = {
      value: 12.5 as unknown as string,
      unit: 'USD_M',
      page: 1,
      quote: 'q',
      confidence: '1',
    };
    expect(() => output.parse(o)).toThrow();
    o.fields.revenue_ltm.value = '1.25e7';
    expect(() => output.parse(o)).toThrow();
    o.fields.revenue_ltm.value = '12.5';
    o.fields.headcount = { value: '12.5', unit: 'COUNT', page: 1, quote: 'q', confidence: '1' };
    expect(() => output.parse(o)).toThrow();
    o.fields.headcount.value = '12';
    o.fields.period_end = {
      value: '2025-02-30',
      unit: 'DATE',
      page: 1,
      quote: 'q',
      confidence: '1',
    };
    expect(() => output.parse(o)).toThrow(/calendar/);
  });

  it('refuses a confidence outside 0 to 1 or as a number, an unknown unit, a page below 1, a missing or extra field', () => {
    const o = clean();
    o.fields.cash = { value: '1', unit: 'USD', page: 1, quote: 'q', confidence: '1.5' };
    expect(() => output.parse(o)).toThrow();
    o.fields.cash.confidence = 0.5 as unknown as string;
    expect(() => output.parse(o)).toThrow();
    o.fields.cash.confidence = '0.5';
    o.fields.cash.unit = 'EUR' as 'USD';
    expect(() => output.parse(o)).toThrow();
    o.fields.cash.unit = 'USD';
    o.fields.cash.page = 0;
    expect(() => output.parse(o)).toThrow();
    o.fields.cash.page = 1;
    const { headcount: _dropped, ...fewer } = o.fields;
    expect(() => output.parse({ ...o, fields: fewer })).toThrow();
    expect(() =>
      output.parse({ ...o, fields: { ...o.fields, invented: o.fields.cash } }),
    ).toThrow();
  });
});

describe('classifierOutputSchema', () => {
  it('accepts a classification with the optional links and refuses a code outside the taxonomy', () => {
    expect(
      classifierOutputSchema.parse({
        docType: 'doc_type.capital_call',
        confidence: '0.97',
        evidence: ['capital call'],
        periodEnd: '2025-06-30',
        investmentNumber: 'INV-0007',
        sponsorFundName: 'Harbor Growth Fund III',
      }).investmentNumber,
    ).toBe('INV-0007');
    expect(
      classifierOutputSchema.parse({ docType: 'doc_type.other', confidence: '0.3', evidence: [] }),
    ).toEqual({ docType: 'doc_type.other', confidence: '0.3', evidence: [] });
    expect(() =>
      classifierOutputSchema.parse({ docType: 'doc_type.memo', confidence: '0.9', evidence: [] }),
    ).toThrow();
    expect(() =>
      classifierOutputSchema.parse({
        docType: 'doc_type.other',
        confidence: '0.9',
        evidence: [],
        investmentNumber: 'INV-7',
      }),
    ).toThrow();
    expect(() =>
      classifierOutputSchema.parse({ docType: 'doc_type.other', confidence: 0.9, evidence: [] }),
    ).toThrow();
  });
});
