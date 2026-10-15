import { D } from '@pb/calc';
import { z } from 'zod';
import { AiError } from '../errors.js';
import { parseMetadata } from '../input.js';
import { parseTruth } from '../models/extractor.js';
import type { Truth } from '../models/extractor.js';
import { REDACTION_KINDS, redact } from '../redact.js';
import type { RedactionKind } from '../redact.js';
import { CONFIDENCE_TEXT } from '../schema.js';
import type { ClassifierOutput } from '../schema.js';
import { isDocTypeCode } from '../taxonomy.js';
import type { DocTypeCode } from '../taxonomy.js';
import { EVAL_THRESHOLDS, runClassifierEval } from './harness.js';
import type { ClassifyFn, EvalResults } from './harness.js';
import type { GoldCase } from './types.js';

/*
 * The gold set loader (docs/07 section 7, docs/14 section 9, decision 0012): turns the synthetic
 * document set (every PDF with its truth sidecar, as `generateDocuments` in tools/synthetic
 * returns it) into the cases the harness scores. The loader names only the fields it reads, so
 * the package entry never imports @pb/synthetic or @pb/pdf: the eval test passes the generated
 * set and `readPdf`, and the API harness could pass the same set it writes to the store.
 */

/** What the loader reads of a truth sidecar: the shape tools/synthetic writes (docs/14 section 9). */
export interface GoldSourceTruth {
  /** SHA-256 of the bytes, lower-case hex; one case per distinct hash. */
  contentHash: string;
  /** A doc_type.* code. */
  docType: string;
  /** Every file name carrying these bytes (two for the duplicate pair); the document's own name when absent. */
  fileNames?: readonly string[];
  investmentNumber: string | null;
  companyName: string | null;
  /** When present, the PDF must read back with this many pages. */
  pageCount?: number;
  /** Scenario tags (injection_doc, duplicate_doc, untagged_doc, restatement). */
  scenarios?: readonly string[];
  /** The type a classifier must answer and the least confidence it must reach; '0' means a person classifies it. */
  expectedClassification: { docType: string; confidenceAtLeast: string };
  /** Read by parseTruth together with highlights and commentary. */
  fields: unknown;
  highlights: unknown;
  commentary: unknown;
}

export interface GoldSourceDocument {
  fileName: string;
  bytes: Uint8Array;
  truth: GoldSourceTruth;
}

/** The part of a document set the loader reads. */
export interface GoldSource {
  documents: readonly GoldSourceDocument[];
}

/** A PDF as the loader needs it: the text of every page in order (what @pb/pdf's readPdf returns). */
export interface GoldPages {
  pages: readonly { text: string }[];
}
export type ReadPagesFn = (bytes: Uint8Array) => Promise<GoldPages>;

export interface ExpectedClassification {
  docType: DocTypeCode;
  /** Decimal text 0 to 1. */
  confidenceAtLeast: string;
}

/** A gold case with what the sidecar says about its classification and scenarios. */
export interface GoldSetCase extends GoldCase {
  fileNames: readonly string[];
  scenarios: readonly string[];
  expectedClassification: ExpectedClassification;
}

function docTypeOf(code: string, fileName: string): DocTypeCode {
  if (!isDocTypeCode(code))
    throw new AiError(
      `the truth of ${fileName} names the document type ${code}, which the taxonomy does not have`,
      'invalid_config',
    );
  return code;
}

function confidenceOf(text: string, fileName: string): string {
  if (!CONFIDENCE_TEXT.test(text))
    throw new AiError(
      `the truth of ${fileName} expects the confidence ${text}, which is not decimal text from 0 to 1`,
      'invalid_config',
    );
  return text;
}

/**
 * One case per distinct content hash, in the set's order: the page texts read back from the
 * bytes, the truth the extractor must answer, the type and the expected classification from the
 * sidecar. The second file of a duplicate pair adds its name to the first case and nothing else.
 * Nothing is excluded: the untagged scan is a case whose expected confidence is below any
 * threshold, and `classificationMisses` checks it lands there instead of scoring its type.
 */
export async function goldCasesFromSet(set: GoldSource, read: ReadPagesFn): Promise<GoldSetCase[]> {
  const cases: GoldSetCase[] = [];
  const byHash = new Map<string, GoldSetCase>();
  for (const document of set.documents) {
    const { fileName, truth } = document;
    const earlier = byHash.get(truth.contentHash);
    if (earlier !== undefined) {
      if (!earlier.fileNames.includes(fileName))
        earlier.fileNames = [...earlier.fileNames, fileName];
      continue;
    }
    const pdf = await read(document.bytes);
    const pageTexts = pdf.pages.map((page) => page.text);
    if (pageTexts.length === 0)
      throw new AiError(`${fileName} reads back with no pages`, 'invalid_input');
    if (truth.pageCount !== undefined && truth.pageCount !== pageTexts.length)
      throw new AiError(
        `${fileName} reads back with ${pageTexts.length} pages, but its truth records ${truth.pageCount}`,
        'invalid_input',
      );
    const c: GoldSetCase = {
      contentHash: truth.contentHash,
      fileName,
      fileNames: truth.fileNames === undefined ? [fileName] : [...truth.fileNames],
      docType: docTypeOf(truth.docType, fileName),
      pageTexts,
      truth: parseTruth(truth),
      investmentNumber: truth.investmentNumber,
      companyName: truth.companyName,
      scenarios: truth.scenarios === undefined ? [] : [...truth.scenarios],
      expectedClassification: {
        docType: docTypeOf(truth.expectedClassification.docType, fileName),
        confidenceAtLeast: confidenceOf(truth.expectedClassification.confidenceAtLeast, fileName),
      },
    };
    byHash.set(c.contentHash, c);
    cases.push(c);
  }
  return cases;
}

/** The truths of the cases keyed by content hash: what `fixtureExtractor` answers from. */
export function truthsOf(cases: readonly GoldCase[]): Map<string, Truth> {
  return new Map(cases.map((c) => [c.contentHash, c.truth]));
}

export interface RedactedGoldCases<C extends GoldCase> {
  cases: C[];
  /** What was replaced across every page, per kind (the counts the API logs; never the text). */
  counts: Record<RedactionKind, number>;
}

/**
 * The cases with every page text redacted, as the API redacts before a model call (SEC-8.7), so
 * the model and the citation check read the same text in the eval as in a run. A quote that
 * stops reading back after redaction is then counted as a missing citation, which is the point.
 */
export function redactGoldCases<C extends GoldCase>(cases: readonly C[]): RedactedGoldCases<C> {
  const counts = Object.fromEntries(REDACTION_KINDS.map((kind) => [kind, 0])) as Record<
    RedactionKind,
    number
  >;
  const redacted = cases.map((c) => {
    const pageTexts = c.pageTexts.map((text) => {
      const result = redact(text);
      for (const kind of REDACTION_KINDS) counts[kind] += result.counts[kind];
      return result.text;
    });
    return { ...c, pageTexts };
  });
  return { cases: redacted, counts };
}

const thresholdDefinitions = z.object({
  classifierConfidenceThreshold: z.number().min(0).max(1),
});

/** `definitions.classifierConfidenceThreshold` (docs/04 M3) as decimal text: an answer below it goes to the review queue. */
export function classifierThresholdFrom(definitions: unknown): string {
  const parsed = thresholdDefinitions.safeParse(definitions);
  if (!parsed.success)
    throw new AiError(
      'config/definitions.json is missing a usable classifierConfidenceThreshold',
      'invalid_config',
    );
  return String(parsed.data.classifierConfidenceThreshold);
}

export interface GoldSplit<C extends GoldSetCase> {
  /** Expected at or above the threshold: scored by type. */
  scored: C[];
  /** Expected below the threshold (the untagged scan): checked to land in review, never scored. */
  review: C[];
}

/** Splits the cases by whether their expected confidence reaches the classifier threshold. */
export function splitByThreshold<C extends GoldSetCase>(
  cases: readonly C[],
  threshold: string,
): GoldSplit<C> {
  const split: GoldSplit<C> = { scored: [], review: [] };
  for (const c of cases) {
    if (D(c.expectedClassification.confidenceAtLeast).lt(D(threshold))) split.review.push(c);
    else split.scored.push(c);
  }
  return split;
}

export type ClassificationMissReason =
  'wrong type' | 'below the expected confidence' | 'a review case reached the threshold';

export interface ClassificationMiss {
  contentHash: string;
  fileName: string;
  expected: ExpectedClassification;
  answered: { docType: DocTypeCode; confidence: string };
  reason: ClassificationMissReason;
}

/**
 * Every case whose answer misses what its sidecar expects: a scored case answered with another
 * type or below its `confidenceAtLeast`, or a review case answered at or above the threshold
 * (it would be auto-classified instead of queued for a person). Empty when the classifier
 * behaves. The inputs are built by the harness, so the metadata is the one the scores use.
 */
export function classificationMisses(
  cases: readonly GoldSetCase[],
  classify: ClassifyFn,
  threshold: string,
): ClassificationMiss[] {
  const answers = new Map<string, ClassifierOutput>();
  const recording: ClassifyFn = (input) => {
    const output = classify(input);
    answers.set(parseMetadata(input).content_hash ?? '', output);
    return output;
  };
  runClassifierEval(cases, recording);
  const misses: ClassificationMiss[] = [];
  const miss = (c: GoldSetCase, output: ClassifierOutput, reason: ClassificationMissReason) =>
    misses.push({
      contentHash: c.contentHash,
      fileName: c.fileName,
      expected: c.expectedClassification,
      answered: { docType: output.docType, confidence: output.confidence },
      reason,
    });
  const { scored, review } = splitByThreshold(cases, threshold);
  for (const c of scored) {
    const output = answers.get(c.contentHash);
    if (output === undefined) continue;
    if (output.docType !== c.expectedClassification.docType) miss(c, output, 'wrong type');
    else if (D(output.confidence).lt(D(c.expectedClassification.confidenceAtLeast)))
      miss(c, output, 'below the expected confidence');
  }
  for (const c of review) {
    const output = answers.get(c.contentHash);
    if (output !== undefined && D(output.confidence).gte(D(threshold)))
      miss(c, output, 'a review case reached the threshold');
  }
  return misses;
}

const ratioText = (value: number | null): string =>
  value === null ? 'undefined (never predicted)' : String(value);

/** One line per metric for the test log and the CI step, with the docs/04 threshold beside each gated one. */
export function evalSummaryLines(results: EvalResults): string[] {
  const lines: string[] = [];
  if (results.classifier !== undefined) {
    const { overall, perType } = results.classifier;
    lines.push(
      `classifier: accuracy ${overall.accuracy} (${overall.correct} of ${overall.cases} cases)`,
    );
    const gated: readonly string[] = EVAL_THRESHOLDS.classifier.docTypes;
    for (const type of Object.keys(perType).sort()) {
      const s = perType[type];
      if (s === undefined) continue;
      const predicted = s.truePositives + s.falsePositives;
      const gate = gated.includes(type)
        ? `, threshold ${EVAL_THRESHOLDS.classifier.precisionAtLeast}`
        : '';
      lines.push(
        `classifier: ${type} precision ${ratioText(s.precision)} (${s.truePositives} of ${predicted} predicted), recall ${ratioText(s.recall)} (${s.truePositives} of ${s.support} labeled)${gate}`,
      );
    }
  }
  if (results.extraction !== undefined) {
    const r = results.extraction;
    const t = EVAL_THRESHOLDS.extraction;
    lines.push(
      `extraction: numeric accuracy ${r.numericAccuracy} (${r.fieldsCorrect} of ${r.fieldsCompared} fields), threshold ${t.numericAccuracyAtLeast}`,
      `extraction: unit errors ${r.unitErrors}, at most ${t.unitErrorsAtMost}`,
      `extraction: missing citations ${r.missingCitations}, at most ${t.missingCitationsAtMost}`,
      `extraction: hallucinations ${r.hallucinations}, at most ${t.hallucinationsAtMost}`,
      `extraction: injection cases changed ${r.injectionCasesChanged} of ${r.cases}, at most ${t.injectionCasesChangedAtMost}`,
      `extraction: cases ${r.cases}, errors ${r.errors}`,
    );
  }
  return lines;
}
