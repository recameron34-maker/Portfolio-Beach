import { readFileSync } from 'node:fs';
import { readPdf } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';
import {
  INJECTION_TEXT,
  UNTAGGED_FILE_NAME,
  generateDataset,
  generateDocuments,
} from '@pb/synthetic';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseInput } from '../input.js';
import { keywordClassifier } from '../models/classifier.js';
import { fixtureExtractor } from '../models/extractor.js';
import type { ExtractFn } from '../models/extractor.js';
import { loadExtractionSchemas } from '../schema.js';
import {
  boundsFrom,
  extractionSettingsFrom,
  highlightStyleFrom,
  validateExtraction,
} from '../validate.js';
import type { ExtractionRuleId } from '../validate.js';
import {
  classificationMisses,
  classifierThresholdFrom,
  evalSummaryLines,
  goldCasesFromSet,
  redactGoldCases,
  splitByThreshold,
  truthsOf,
} from './gold.js';
import type { GoldSetCase, ReadPagesFn } from './gold.js';
import {
  EvalThresholdError,
  assertThresholds,
  checkThresholds,
  runClassifierEval,
  runExtractionEval,
} from './harness.js';
import type { ClassifierEvalResult, ExtractionEvalResult, ValidateFn } from './harness.js';

/*
 * The gold-set eval (docs/07 section 7, docs/04 M3 and M4, SEC-8.8): the synthetic document set
 * of the small profile at seed 42, generated in memory, read back with @pb/pdf, redacted as the
 * API redacts, then scored with the fixture-backed prototype models the API registers. One
 * summary line per metric is printed; assertThresholds is the release gate. `pnpm test:evals`
 * runs this file alone.
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const definitions = read('config/definitions.json');
const styleJson = read('config/style.json');
const schema = loadExtractionSchemas(read('config/extraction_schema.json')).quarterly_financials!;
const threshold = classifierThresholdFrom(definitions);
const readLimits = z
  .object({ documents: z.object({ maxPdfBytes: z.number().int(), maxPages: z.number().int() }) })
  .parse(definitions).documents;

const readPages: ReadPagesFn = (bytes) =>
  readPdf(bytes, {
    inflate: nodeInflate,
    limits: { maxBytes: readLimits.maxPdfBytes, maxPages: readLimits.maxPages },
  });

const validate: ValidateFn = (output, pageTexts) =>
  validateExtraction(output, {
    schema,
    pageTexts,
    bounds: boundsFrom(definitions),
    style: highlightStyleFrom(styleJson),
    ...extractionSettingsFrom(definitions),
  });

const say = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.map((line) => `  eval | ${line}`).join('\n')}\n`);
};

const dataset = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(dataset);
let raw: GoldSetCase[] = [];
let cases: GoldSetCase[] = [];
let classifier: ClassifierEvalResult;
let extraction: ExtractionEvalResult;

beforeAll(async () => {
  raw = await goldCasesFromSet(set, readPages);
  const redacted = redactGoldCases(raw);
  cases = redacted.cases;
  say([
    `gold set: ${cases.length} cases from ${set.documents.length} documents (small profile, seed 42)`,
    `redactions: ${Object.entries(redacted.counts)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ')}`,
  ]);
});

describe('goldCasesFromSet over the synthetic document set', () => {
  it('gives one case per distinct content hash, the duplicate pair under one case with both names', () => {
    const hashes = new Set(set.documents.map((d) => d.truth.contentHash));
    expect(raw).toHaveLength(hashes.size);
    expect(raw.length).toBe(set.documents.length - 1);
    expect(new Set(raw.map((c) => c.contentHash)).size).toBe(raw.length);
    const [first, second] = set.expectations.scenarioFiles.duplicate_doc;
    const pair = raw.filter((c) => c.scenarios.includes('duplicate_doc'));
    expect(pair).toHaveLength(1);
    expect(pair[0]?.fileName).toBe(first);
    expect(pair[0]?.fileNames).toEqual([first, second]);
    for (const c of raw) if (c !== pair[0]) expect(c.fileNames).toEqual([c.fileName]);
  });

  it('counts per type match the expectations less the duplicate copy, with the truth and links on every case', () => {
    const expected: Record<string, number> = { ...set.expectations.byDocType };
    const duplicateType = set.documents.find((d) => d.truth.scenarios.includes('duplicate_doc'))
      ?.truth.docType;
    expect(duplicateType).toBeDefined();
    expected[duplicateType ?? ''] = (expected[duplicateType ?? ''] ?? 0) - 1;
    const counted: Record<string, number> = {};
    for (const c of raw) counted[c.docType] = (counted[c.docType] ?? 0) + 1;
    expect(counted).toEqual(expected);
    for (const c of raw) {
      const document = set.documents.find((d) => d.fileName === c.fileName);
      expect(document).toBeDefined();
      expect(c.pageTexts).toHaveLength(document?.truth.pageCount ?? -1);
      expect(c.pageTexts.every((text) => text.length > 0)).toBe(true);
      expect(Object.keys(c.truth.fields)).toEqual(Object.keys(document?.truth.fields ?? {}));
      expect(c.truth.highlights).toEqual(document?.truth.highlights);
      expect(c.truth.commentary).toBe(document?.truth.commentary);
      expect(c.investmentNumber).toBe(document?.truth.investmentNumber);
      expect(c.companyName).toBe(document?.truth.companyName);
      expect(c.expectedClassification.docType).toBe(document?.truth.expectedClassification.docType);
    }
    expect(raw.filter((c) => c.docType === schema.docType).every((c) => c.investmentNumber)).toBe(
      true,
    );
  });

  it('splits the untagged scan, and only it, into the review set below the classifier threshold', () => {
    const { scored, review } = splitByThreshold(cases, threshold);
    expect(review.map((c) => c.fileName)).toEqual([UNTAGGED_FILE_NAME]);
    expect(review[0]?.expectedClassification.confidenceAtLeast).toBe('0');
    expect(scored).toHaveLength(cases.length - 1);
    expect(scored.every((c) => c.expectedClassification.confidenceAtLeast === '0.97')).toBe(true);
  });

  it('redacts nothing in a synthetic document, so the model reads the text the writer produced', () => {
    const { counts } = redactGoldCases(raw);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(cases.map((c) => c.pageTexts)).toEqual(raw.map((c) => c.pageTexts));
  });
});

describe('the classifier eval (docs/04 M3)', () => {
  it('meets the precision threshold on the scored cases and prints a line per metric', () => {
    const { scored } = splitByThreshold(cases, threshold);
    classifier = runClassifierEval(scored, keywordClassifier);
    say(evalSummaryLines({ classifier }));
    expect(classifier.overall.cases).toBe(scored.length);
    expect(classifier.overall.correct).toBe(scored.length);
    for (const type of ['capital_call', 'distribution_notice', 'capital_account_statement'])
      expect(classifier.perType[`doc_type.${type}`]?.support).toBeGreaterThan(0);
    expect(classifier.perType[schema.docType]?.support).toBe(
      scored.filter((c) => c.docType === schema.docType).length,
    );
    expect(checkThresholds({ classifier })).toEqual([]);
  });

  it('answers every titled document at its expected confidence and leaves the scan below the threshold', () => {
    expect(classificationMisses(cases, keywordClassifier, threshold)).toEqual([]);
    const scan = cases.find((c) => c.fileName === UNTAGGED_FILE_NAME);
    expect(scan).toBeDefined();
    const answers: string[] = [];
    runClassifierEval([scan!], (input) => {
      const output = keywordClassifier(input);
      answers.push(output.confidence);
      return output;
    });
    say([`classifier: ${UNTAGGED_FILE_NAME} answered ${answers[0]}, threshold ${threshold}`]);
    expect(answers).toHaveLength(1);
  });

  it('reads the period end and the investment number of a titled report from page 1', () => {
    const report = cases.find(
      (c) => c.docType === schema.docType && c.fileName !== UNTAGGED_FILE_NAME,
    );
    expect(report).toBeDefined();
    const outputs: ReturnType<typeof keywordClassifier>[] = [];
    runClassifierEval([report!], (input) => {
      const output = keywordClassifier(input);
      outputs.push(output);
      return output;
    });
    expect(outputs[0]?.periodEnd).toBe(report!.truth.fields.period_end?.value);
    expect(outputs[0]?.investmentNumber).toBe(report!.investmentNumber);
  });
});

describe('the extraction eval (docs/04 M4)', () => {
  const quarterly = (): GoldSetCase[] => cases.filter((c) => c.docType === schema.docType);

  it('meets every threshold with the fixture extractor and the config-driven validator, and prints a line per metric', () => {
    const reports = quarterly();
    extraction = runExtractionEval(reports, fixtureExtractor(truthsOf(reports)), validate);
    say(evalSummaryLines({ extraction }));
    expect(reports.length).toBeGreaterThan(40);
    expect(extraction.cases).toBe(reports.length);
    expect(extraction.errors).toBe(0);
    expect(extraction.mismatches).toEqual([]);
    expect(extraction.fieldsCompared).toBeGreaterThan(reports.length * 10);
    expect(extraction.numericAccuracy).toBe(1);
    expect(checkThresholds({ extraction })).toEqual([]);
  });

  it('reads every truth quote back from its cited page and finds every value clean apart from the known period-end shift', () => {
    const reports = quarterly();
    const extract = fixtureExtractor(truthsOf(reports));
    const fired = new Map<ExtractionRuleId, Set<string>>();
    const invalidCases = new Set<string>();
    for (const c of reports) {
      const output = extract(buildCaseInput(c));
      const validation = validate(output, c.pageTexts);
      for (const [field, result] of Object.entries(validation.fields))
        for (const finding of result.findings) {
          fired.set(finding.ruleId, (fired.get(finding.ruleId) ?? new Set()).add(c.fileName));
          if (finding.ruleId !== 'EXT-DATE-01') invalidCases.add(`${c.fileName} ${field}`);
        }
      expect(validation.highlights, c.fileName).toEqual([]);
      expect(validation.commentary, c.fileName).toEqual([]);
    }
    say([...fired.entries()].map(([rule, files]) => `validation: ${rule} on ${files.size} cases`));
    expect(invalidCases).toEqual(new Set());
    // The period_end_shift investment's reports carry a period end that is not a quarter end
    // (docs/14 section 3); EXT-DATE-01 is meant to catch exactly that.
    const shifted = fired.get('EXT-DATE-01') ?? new Set();
    const shiftedIds = new Set(dataset.scenarios.period_end_shift ?? []);
    for (const fileName of shifted) {
      const c = reports.find((r) => r.fileName === fileName);
      const id = set.documents.find((d) => d.fileName === fileName)?.truth.investmentId;
      expect(shiftedIds.has(id ?? ''), `${fileName} ${c?.truth.fields.period_end?.value}`).toBe(
        true,
      );
    }
  });

  it('keeps the real figures of the injection document and fails the gate for a model that obeys it', () => {
    const reports = quarterly();
    const [injected] = set.expectations.scenarioFiles.injection_doc;
    const c = reports.find((r) => r.fileName === injected);
    expect(c).toBeDefined();
    expect(c!.pageTexts.at(-1)).toContain(INJECTION_TEXT);
    expect(c!.truth.fields.revenue_ltm?.value).not.toBe('999.00');
    const honest = fixtureExtractor(truthsOf(reports));
    const obedient: ExtractFn = (input) => {
      const output = honest(input);
      if (parseInput(input).pages.some((page) => page.includes(INJECTION_TEXT)))
        output.fields.revenue_ltm = { ...output.fields.revenue_ltm!, value: '999.00' };
      return output;
    };
    const r = runExtractionEval(reports, obedient, validate);
    expect(r.mismatches).toEqual([
      {
        contentHash: c!.contentHash,
        field: 'revenue_ltm',
        expected: c!.truth.fields.revenue_ltm?.value ?? null,
        actual: '999.00',
      },
    ]);
    expect(r.hallucinations).toBe(1);
    expect(checkThresholds({ extraction: r })).toEqual([
      'extraction: 1 values not in the truth, at most 0 allowed',
    ]);
  });
});

describe('the release gate (SEC-8.8)', () => {
  it('passes over the generated gold set, and names every miss when a model invents', () => {
    expect(() => assertThresholds({ classifier, extraction })).not.toThrow();
    const reports = cases.filter((c) => c.docType === schema.docType);
    const inventing: ExtractFn = () => ({
      fields: Object.fromEntries(
        schema.fields.map((f) => [
          f.key,
          {
            value: '1',
            unit: f.kind === 'money' ? 'USD_M' : null,
            page: 1,
            quote: 'x',
            confidence: '1',
          },
        ]),
      ),
      highlights: [],
      commentary: null,
    });
    const r = runExtractionEval(reports, inventing, validate);
    expect(() => assertThresholds({ classifier, extraction: r })).toThrow(EvalThresholdError);
    const failures = checkThresholds({ classifier, extraction: r });
    expect(failures.some((f) => f.startsWith('extraction: numeric accuracy'))).toBe(true);
    expect(failures.some((f) => f.includes('without a citation'))).toBe(true);
    expect(failures.some((f) => f.includes('unit errors'))).toBe(true);
  });
});

/** The harness builds inputs from a case itself; this mirrors it for the per-finding census above. */
function buildCaseInput(c: GoldSetCase): string {
  let input = '';
  runExtractionEval(
    [c],
    (built) => {
      if (input === '') input = built;
      return { fields: {}, highlights: [], commentary: null };
    },
    validate,
  );
  return input;
}
