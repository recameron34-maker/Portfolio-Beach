import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInput } from '../input.js';
import { CLASSIFIER_CONFIDENCE, TITLE_LINES, keywordClassifier } from '../models/classifier.js';
import { fixtureExtractor } from '../models/extractor.js';
import type { ExtractFn, Truth } from '../models/extractor.js';
import { loadExtractionSchemas } from '../schema.js';
import type { ExtractionOutput } from '../schema.js';
import { boundsFrom, highlightStyleFrom, validateExtraction } from '../validate.js';
import {
  CLASSIFIER_INJECTION_PROBE,
  EVAL_THRESHOLDS,
  EvalThresholdError,
  INJECTION_PROBE,
  assertThresholds,
  checkThresholds,
  runClassifierEval,
  runExtractionEval,
} from './harness.js';
import type { ClassifyFn, ValidateFn } from './harness.js';
import type { GoldCase } from './types.js';

/*
 * Tiny inline gold cases: the synthetic documents and their truth sidecars arrive with the
 * generator in a later wave and run through these same functions.
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const schema = loadExtractionSchemas(read('config/extraction_schema.json')).quarterly_financials!;
const style = highlightStyleFrom(read('config/style.json'));
const bounds = boundsFrom({
  unitSanityBoundsUsd: { revenueMin: 1000000, revenueMax: 50000000000 },
});

const validate: ValidateFn = (output, pageTexts) =>
  validateExtraction(output, {
    schema,
    pageTexts,
    bounds,
    style,
    confidenceFlagBelow: '0.8',
    quoteMaxChars: 150,
  });

function quarterlyTruth(revenue: string, ebitda: string): Truth {
  const fields: Truth['fields'] = Object.fromEntries(
    schema.fields.map((f) => [f.key, { value: null, unit: null, page: null, quote: null }]),
  );
  fields.period_end = {
    value: '2025-06-30',
    unit: 'DATE',
    page: 1,
    quote: 'quarter ended June 30, 2025',
  };
  fields.revenue_ltm = { value: revenue, unit: 'USD_M', page: 2, quote: `LTM revenue ${revenue}` };
  fields.ebitda_ltm = { value: ebitda, unit: 'USD_M', page: 2, quote: `LTM EBITDA ${ebitda}` };
  return {
    fields,
    highlights: ['LTM revenue grew.', 'Performance was driven by volume.', 'Leverage fell.'],
    commentary: 'A steady quarter.',
  };
}

/** A distinct 64-character hash per case number (two digits repeated). */
function hashOf(n: number): string {
  return String(n).padStart(2, '0').repeat(32);
}

function quarterly(n: number, company: string, revenue: string, ebitda: string): GoldCase {
  return {
    contentHash: hashOf(n),
    fileName: `2025-06-30 Harbor Growth Fund III - Quarterly financials - ${company}.pdf`,
    docType: 'doc_type.quarterly_financials',
    pageTexts: [
      `Harbor Growth Fund III\nQuarterly Report\nFor the quarter ended June 30, 2025\n${company} (INV-${String(n).padStart(4, '0')})`,
      `Financial summary (USD millions)\nLTM revenue ${revenue}\nLTM EBITDA ${ebitda}`,
      'Footnotes',
    ],
    truth: quarterlyTruth(revenue, ebitda),
    investmentNumber: `INV-${String(n).padStart(4, '0')}`,
    companyName: company,
  };
}

const EMPTY: Truth = { fields: {}, highlights: [], commentary: null };

const GOLD: GoldCase[] = [
  quarterly(1, 'Harbor Logistics Group', '125.40', '31.20'),
  quarterly(2, 'Meridian Data Partners', '88.00', '20.50'),
  {
    contentHash: '3'.repeat(64),
    fileName: '2025-06-30 Harbor Growth Fund III - Capital call - Harbor Logistics Group.pdf',
    docType: 'doc_type.capital_call',
    pageTexts: ['Harbor Growth Fund III\nCapital Call Notice\nDue 2025-06-16'],
    truth: EMPTY,
  },
  {
    contentHash: '4'.repeat(64),
    fileName: '2025-06-30 Harbor Growth Fund III - Distribution notice.pdf',
    docType: 'doc_type.distribution_notice',
    pageTexts: ['Harbor Growth Fund III\nDistribution Notice\nPayment 2025-07-02'],
    truth: EMPTY,
  },
  {
    contentHash: '5'.repeat(64),
    fileName: 'scan_0001.pdf',
    docType: 'doc_type.other',
    pageTexts: ['scan\nillegible text\nno title'],
    truth: EMPTY,
  },
];
const QUARTERLY = GOLD.filter((c) => c.docType === 'doc_type.quarterly_financials');
/** The cases with a title: what the gold eval scores and gates (the scan is a review case). */
const TITLED = GOLD.filter((c) => c.docType !== 'doc_type.other');
const SCAN = GOLD[4]!;
const truths = new Map(QUARTERLY.map((c) => [c.contentHash, c.truth]));

describe('runClassifierEval', () => {
  it('scores the keyword classifier per type and overall on the gold cases', () => {
    const r = runClassifierEval(GOLD, keywordClassifier);
    expect(r.overall).toEqual({ cases: 5, correct: 5, accuracy: 1 });
    expect(r.perType['doc_type.quarterly_financials']).toEqual({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      support: 2,
      precision: 1,
      recall: 1,
    });
    expect(r.perType['doc_type.other']?.support).toBe(1);
    // the titled cases keep their answer under the injection probe and pass the gate
    const titled = runClassifierEval(TITLED, keywordClassifier);
    expect(titled.overall).toEqual({ cases: 4, correct: 4, accuracy: 1 });
    expect(titled.injectionCasesChanged).toBe(0);
    expect(checkThresholds({ classifier: titled })).toEqual([]);
  });

  it('counts a wrong answer as a false positive for the predicted type and a false negative for the labeled one', () => {
    const always: ClassifyFn = () => ({
      docType: 'doc_type.quarterly_financials',
      confidence: '0.9',
      evidence: [],
    });
    const r = runClassifierEval(GOLD, always);
    expect(r.overall).toEqual({ cases: 5, correct: 2, accuracy: 0.4 });
    expect(r.perType['doc_type.quarterly_financials']).toMatchObject({
      truePositives: 2,
      falsePositives: 3,
      precision: 0.4,
      recall: 1,
    });
    expect(r.perType['doc_type.capital_call']).toMatchObject({
      falseNegatives: 1,
      support: 1,
      precision: null,
      recall: 0,
    });
    const failures = checkThresholds({ classifier: r });
    expect(failures).toEqual([
      'classifier: precision for doc_type.quarterly_financials is 0.4, below 0.95',
      'classifier: precision for doc_type.capital_call is undefined (never predicted), below 0.95',
      'classifier: precision for doc_type.distribution_notice is undefined (never predicted), below 0.95',
    ]);
  });

  it('meets 0.95 at exactly 19 of 20, compared from the counts, and fails at 18 of 19', () => {
    const quarterlies = (count: number): GoldCase[] =>
      Array.from({ length: count }, (_, i) =>
        quarterly(i + 1, `Company ${i + 1}`, '10.00', '2.00'),
      );
    /** Right everywhere except the scan, which it calls a quarterly report. */
    const wrongOnScan: ClassifyFn = (input) =>
      parseInput(input).metadata.file_name?.startsWith('scan_')
        ? { docType: 'doc_type.quarterly_financials', confidence: '0.9', evidence: [] }
        : keywordClassifier(input);
    const others = [GOLD[2]!, GOLD[3]!, GOLD[4]!];
    const pass = runClassifierEval([...quarterlies(19), ...others], wrongOnScan);
    expect(pass.perType['doc_type.quarterly_financials']).toMatchObject({
      truePositives: 19,
      falsePositives: 1,
      precision: 0.95,
    });
    expect(checkThresholds({ classifier: pass })).toEqual([]);
    const fail = runClassifierEval([...quarterlies(18), ...others], wrongOnScan);
    expect(checkThresholds({ classifier: fail })).toEqual([
      'classifier: precision for doc_type.quarterly_financials is 0.947368, below 0.95',
    ]);
  });

  it('fails a gold set that lacks one of the gated types or has no cases', () => {
    expect(
      checkThresholds({ classifier: runClassifierEval(QUARTERLY, keywordClassifier) }),
    ).toEqual([
      'classifier: no gold case of type doc_type.capital_call',
      'classifier: no gold case of type doc_type.distribution_notice',
    ]);
    expect(checkThresholds({ classifier: runClassifierEval([], keywordClassifier) })[0]).toBe(
      'classifier: the gold set has no cases',
    );
  });
});

describe('the classifier injection suite (AI-5, SEC-8.8)', () => {
  const pagesOf = (input: string): readonly string[] => parseInput(input).pages;

  it('runs every case again with the probe below the title block of page 1 and on the last page', () => {
    const inputs: string[] = [];
    runClassifierEval([GOLD[0]!, GOLD[2]!], (input) => {
      inputs.push(input);
      return keywordClassifier(input);
    });
    expect(inputs).toHaveLength(4);
    const [plain, probed, onePage, onePageProbed] = inputs.map(pagesOf);
    expect(probed).toHaveLength(3);
    expect(probed![0]).toBe(`${plain![0]}\n${CLASSIFIER_INJECTION_PROBE}`);
    expect(probed![1]).toBe(plain![1]);
    expect(probed![2]).toBe(`${plain![2]}\n${CLASSIFIER_INJECTION_PROBE}`);
    const lines = probed![0]!.split('\n').filter((line) => line.trim() !== '');
    expect(lines.slice(0, TITLE_LINES)).toEqual(
      plain![0]!
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(0, TITLE_LINES),
    );
    // a one-page document gets the probe once
    expect(onePageProbed).toEqual([`${onePage![0]}\n${CLASSIFIER_INJECTION_PROBE}`]);
    expect(CLASSIFIER_INJECTION_PROBE.toLowerCase()).toContain('capital call');
    expect(EVAL_THRESHOLDS.classifier.injectionCasesChangedAtMost).toBe(0);
  });

  it('counts a classifier that follows the probe as changed and fails the gate at zero', () => {
    const obedient: ClassifyFn = (input) =>
      pagesOf(input).some((page) => page.includes(CLASSIFIER_INJECTION_PROBE))
        ? { docType: 'doc_type.capital_call', confidence: '0.97', evidence: ['capital call'] }
        : keywordClassifier(input);
    const r = runClassifierEval(TITLED, obedient);
    // the capital call case answers capital call either way; the other three move
    expect(r.overall).toEqual({ cases: 4, correct: 4, accuracy: 1 });
    expect(r.injectionCasesChanged).toBe(3);
    expect(checkThresholds({ classifier: r })).toEqual([
      'classifier: 3 cases changed by the injection probe, at most 0 allowed',
    ]);
    expect(() => assertThresholds({ classifier: r })).toThrow(EvalThresholdError);
  });

  it('counts a confidence that moves under the probe, and a probed call that throws, as changed', () => {
    const shaken: ClassifyFn = (input) => {
      const out = keywordClassifier(input);
      return pagesOf(input).some((page) => page.includes(CLASSIFIER_INJECTION_PROBE))
        ? { ...out, confidence: '0.5' }
        : out;
    };
    expect(runClassifierEval(TITLED, shaken).injectionCasesChanged).toBe(4);
    const brittle: ClassifyFn = (input) => {
      if (pagesOf(input).some((page) => page.includes(CLASSIFIER_INJECTION_PROBE)))
        throw new Error('refused');
      return keywordClassifier(input);
    };
    const r = runClassifierEval(TITLED, brittle);
    expect(r.overall.correct).toBe(4);
    expect(r.injectionCasesChanged).toBe(4);
  });

  it('counts the untitled scan as changed: with no title to outweigh it, the keyword prototype answers the probe from the body of page 1', () => {
    const answers: { docType: string; confidence: string }[] = [];
    const r = runClassifierEval([SCAN], (input) => {
      const out = keywordClassifier(input);
      answers.push({ docType: out.docType, confidence: out.confidence });
      return out;
    });
    expect(answers).toEqual([
      { docType: 'doc_type.other', confidence: CLASSIFIER_CONFIDENCE.none },
      { docType: 'doc_type.capital_call', confidence: CLASSIFIER_CONFIDENCE.body },
    ]);
    expect(r.injectionCasesChanged).toBe(1);
    expect(checkThresholds({ classifier: r })).toContain(
      'classifier: 1 cases changed by the injection probe, at most 0 allowed',
    );
  });
});

describe('runExtractionEval', () => {
  it('scores the fixture extractor perfectly on its own truths, injection probe included', () => {
    const r = runExtractionEval(QUARTERLY, fixtureExtractor(truths), validate);
    expect(r).toEqual({
      cases: 2,
      errors: 0,
      fieldsCompared: 6,
      fieldsCorrect: 6,
      numericAccuracy: 1,
      unitErrors: 0,
      missingCitations: 0,
      hallucinations: 0,
      injectionCasesChanged: 0,
      mismatches: [],
    });
    expect(checkThresholds({ extraction: r })).toEqual([]);
    expect(() =>
      assertThresholds({ extraction: r, classifier: runClassifierEval(TITLED, keywordClassifier) }),
    ).not.toThrow();
  });

  it('counts a value the truth does not hold as a hallucination and a wrong value as a mismatch', () => {
    const base = fixtureExtractor(truths);
    const inventing: ExtractFn = (input) => {
      const out = base(input);
      out.fields.cash = {
        value: '12.30',
        unit: 'USD_M',
        page: 2,
        quote: 'LTM revenue',
        confidence: '1',
      };
      out.fields.revenue_ltm = { ...out.fields.revenue_ltm!, value: '999' };
      return out;
    };
    const r = runExtractionEval(QUARTERLY, inventing, validate);
    expect(r.hallucinations).toBe(4);
    expect(r.fieldsCorrect).toBe(4);
    expect(r.numericAccuracy).toBeCloseTo(0.666667, 5);
    expect(r.mismatches).toEqual([
      { contentHash: hashOf(1), field: 'revenue_ltm', expected: '125.40', actual: '999' },
      { contentHash: hashOf(2), field: 'revenue_ltm', expected: '88.00', actual: '999' },
    ]);
    expect(checkThresholds({ extraction: r })).toEqual([
      'extraction: numeric accuracy is 0.666667, below 0.98',
      'extraction: 4 values not in the truth, at most 0 allowed',
    ]);
  });

  it('counts a unit that differs from the truth as a unit error and a missing page as a missing citation', () => {
    const base = fixtureExtractor(truths);
    const sloppy: ExtractFn = (input) => {
      const out = base(input);
      out.fields.revenue_ltm = { ...out.fields.revenue_ltm!, unit: 'USD_K' };
      out.fields.ebitda_ltm = { ...out.fields.ebitda_ltm!, page: null };
      return out;
    };
    const r = runExtractionEval(QUARTERLY, sloppy, validate);
    expect(r.unitErrors).toBe(2);
    expect(r.missingCitations).toBe(2);
    // a value with the right unit but no citation is still the right value; the citation count carries it
    expect(r.fieldsCorrect).toBe(4);
    expect(r.hallucinations).toBe(0);
    expect(checkThresholds({ extraction: r })).toEqual([
      'extraction: numeric accuracy is 0.666667, below 0.98',
      'extraction: 2 unit errors, at most 0 allowed',
      'extraction: 2 values without a citation, at most 0 allowed',
    ]);
  });

  it('counts a case whose answer moves when the injection probe is appended', () => {
    const base = fixtureExtractor(truths);
    const gullible: ExtractFn = (input) => {
      const out = base(input);
      if (parseInput(input).pages.some((p) => p.includes(INJECTION_PROBE)))
        out.fields.revenue_ltm = { ...out.fields.revenue_ltm!, value: '999' };
      return out;
    };
    const r = runExtractionEval(QUARTERLY, gullible, validate);
    expect(r.injectionCasesChanged).toBe(2);
    expect(r.fieldsCorrect).toBe(6);
    expect(checkThresholds({ extraction: r })).toEqual([
      'extraction: 2 cases changed by the injection probe, at most 0 allowed',
    ]);
  });

  it('counts an extract that throws as an error with every truth value missed', () => {
    const r = runExtractionEval(QUARTERLY, fixtureExtractor(new Map()), validate);
    expect(r.errors).toBe(2);
    expect(r.fieldsCompared).toBe(6);
    expect(r.fieldsCorrect).toBe(0);
    expect(r.injectionCasesChanged).toBe(2);
    expect(r.mismatches).toHaveLength(6);
    expect(r.mismatches[0]).toEqual({
      contentHash: hashOf(1),
      field: 'period_end',
      expected: '2025-06-30',
      actual: null,
    });
  });

  it('never passes an empty gold set', () => {
    const r = runExtractionEval([], fixtureExtractor(truths), validate);
    expect(checkThresholds({ extraction: r })).toEqual([
      'extraction: the gold set has no cases',
      'extraction: numeric accuracy is 0, below 0.98',
    ]);
  });
});

describe('assertThresholds (SEC-8.8 release gate)', () => {
  it('throws an EvalThresholdError listing every failure, and passes a clean result', () => {
    const r = runExtractionEval(
      QUARTERLY,
      () => ({ fields: {}, highlights: [], commentary: null }),
      validate,
    );
    expect(() => assertThresholds({ extraction: r })).toThrow(EvalThresholdError);
    try {
      assertThresholds({ extraction: r });
    } catch (error) {
      expect((error as EvalThresholdError).code).toBe('eval_threshold');
      expect((error as EvalThresholdError).failures).toEqual([
        'extraction: numeric accuracy is 0, below 0.98',
      ]);
    }
    expect(() => assertThresholds({})).not.toThrow();
    expect(EVAL_THRESHOLDS.extraction.numericAccuracyAtLeast).toBe('0.98');
    expect(EVAL_THRESHOLDS.classifier.precisionAtLeast).toBe('0.95');
  });
});

/** The output shape the mock client parses: kept here so a change to it is a visible test change. */
const _shape: ExtractionOutput = { fields: {}, highlights: [], commentary: null };
