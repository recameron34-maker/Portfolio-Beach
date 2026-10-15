import { ISO_DATE, isCalendarDate, parseMonthDayYear } from '../dates.js';
import { parseInput } from '../input.js';
import { classifierOutputSchema } from '../schema.js';
import type { ClassifierOutput } from '../schema.js';
import type { DocTypeCode } from '../taxonomy.js';

/*
 * The prototype classifier (docs/04 M3, decision 0012): a keyword model that reads the first
 * page's text and the file name for the document type signatures and answers with a confidence
 * that states where the evidence was found, so the review queue threshold means something. It
 * stands in for a real model behind the same prompt id; the signature table is a constant here so
 * it can move to config without a code change elsewhere.
 */

export interface DocTypeSignature {
  docType: DocTypeCode;
  /** Matched case-insensitively; the first phrase listed is the one the file name label uses. */
  phrases: readonly string[];
}

/** In priority order: when two types match at the same evidence tier, the earlier entry wins. */
export const DOC_TYPE_SIGNATURES: readonly DocTypeSignature[] = [
  {
    docType: 'doc_type.capital_account_statement',
    phrases: ['capital account statement', 'statement of partners capital'],
  },
  { docType: 'doc_type.capital_call', phrases: ['capital call', 'drawdown notice', 'call notice'] },
  { docType: 'doc_type.distribution_notice', phrases: ['distribution notice'] },
  {
    docType: 'doc_type.quarterly_financials',
    phrases: [
      'quarterly financials',
      'quarterly report',
      'quarterly update',
      'quarterly financial',
    ],
  },
  {
    docType: 'doc_type.quarterly_letter',
    phrases: ['quarterly letter', 'letter to limited partners'],
  },
  { docType: 'doc_type.k1', phrases: ['k-1', 'schedule k-1'] },
  {
    docType: 'doc_type.audited_financials',
    phrases: ['audited financials', 'audited financial statements', 'independent auditor'],
  },
  { docType: 'doc_type.cim', phrases: ['cim', 'confidential information memorandum'] },
  { docType: 'doc_type.management_presentation', phrases: ['management presentation'] },
  { docType: 'doc_type.lpa', phrases: ['lpa', 'limited partnership agreement'] },
  { docType: 'doc_type.side_letter', phrases: ['side letter'] },
  {
    docType: 'doc_type.subscription_docs',
    phrases: ['subscription docs', 'subscription agreement'],
  },
  { docType: 'doc_type.closing_set', phrases: ['closing set', 'closing binder'] },
  { docType: 'doc_type.valuation_support', phrases: ['valuation support', 'valuation memorandum'] },
  {
    docType: 'doc_type.agm_materials',
    phrases: ['agm materials', 'annual meeting', 'annual general meeting'],
  },
];

/** The confidence answered per evidence tier, as decimal text (definitions.classifierConfidenceThreshold decides review). */
export const CLASSIFIER_CONFIDENCE = {
  /** A phrase in the title block (the first lines of page 1). */
  title: '0.97',
  /** A phrase in the body of page 1 only. */
  body: '0.88',
  /** A phrase in the file name only. */
  fileName: '0.6',
  /** No phrase anywhere: doc_type.other. */
  none: '0.3',
} as const;
export type EvidenceTier = keyof typeof CLASSIFIER_CONFIDENCE;

/** How many leading non-empty lines of page 1 count as the title block. */
export const TITLE_LINES = 3;

/** A phrase contained in another matched phrase ("quarterly financial" in "quarterly financials") says nothing more. */
function distinctEvidence(phrases: readonly string[]): string[] {
  return phrases.filter(
    (phrase) => !phrases.some((other) => other !== phrase && other.includes(phrase)),
  );
}

const TIER_RANK: Record<EvidenceTier, number> = { title: 3, body: 2, fileName: 1, none: 0 };

export interface DocumentFileName {
  periodEnd: string;
  sponsorFundName: string;
  docTypeLabel: string;
  /** Null for a fund document (`<period_end> <fund> - <label>.pdf`). */
  companyName: string | null;
}

/**
 * The synthetic store's file name convention (docs/14): `<period_end> <Sponsor fund name> - <Doc
 * type label> - <Company name>.pdf`, or without the company for a fund document. Null when the
 * name does not follow it (a scan, a file someone renamed).
 */
export function parseDocumentFileName(fileName: string): DocumentFileName | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (.+)\.pdf$/i.exec(fileName);
  if (match === null) return null;
  const [, periodEnd = '', rest = ''] = match;
  if (!isCalendarDate(periodEnd)) return null;
  const parts = rest.split(' - ').map((p) => p.trim());
  const [sponsorFundName, docTypeLabel, companyName] = parts;
  if (parts.length < 2 || parts.length > 3 || !sponsorFundName || !docTypeLabel) return null;
  if (parts.length === 3 && !companyName) return null;
  return { periodEnd, sponsorFundName, docTypeLabel, companyName: companyName ?? null };
}

const PERIOD_PHRASE = /\b(?:quarter|period|year|three months|twelve months)\s+(?:ended|ending)\s+/i;
const AS_OF = /\bas\s+of\s+/i;
const INVESTMENT_NUMBER = /\bINV-\d{4}\b/;

function periodEndFrom(pageOne: string, fileName: string): string | null {
  for (const lead of [PERIOD_PHRASE, AS_OF]) {
    const at = lead.exec(pageOne);
    if (at !== null) {
      const tail = pageOne.slice(at.index + at[0].length, at.index + at[0].length + 40);
      const monthDayYear = parseMonthDayYear(tail);
      if (monthDayYear !== null) return monthDayYear;
      const iso = /^\d{4}-\d{2}-\d{2}/.exec(tail);
      if (iso !== null && isCalendarDate(iso[0])) return iso[0];
    }
  }
  const anyIso = /\b\d{4}-\d{2}-\d{2}\b/.exec(pageOne);
  if (anyIso !== null && isCalendarDate(anyIso[0])) return anyIso[0];
  const fromName = parseDocumentFileName(fileName);
  return fromName?.periodEnd ?? null;
}

/**
 * Classifies a model input built by buildInput. Evidence is looked for in the title block, then
 * the rest of page 1, then the file name; the best tier of each signature competes, the table
 * order breaks ties, and a document with no evidence is doc_type.other at the lowest confidence.
 */
export function keywordClassifier(input: string): ClassifierOutput {
  const { metadata, pages } = parseInput(input);
  const fileName = metadata.file_name ?? '';
  const pageOne = pages[0] ?? '';
  const lines = pageOne.split('\n').filter((line) => line.trim() !== '');
  const title = lines.slice(0, TITLE_LINES).join('\n').toLowerCase();
  const body = lines.slice(TITLE_LINES).join('\n').toLowerCase();
  const name = fileName.toLowerCase();

  let best: { docType: DocTypeCode; tier: EvidenceTier; evidence: string[] } | null = null;
  for (const signature of DOC_TYPE_SIGNATURES) {
    let tier: EvidenceTier = 'none';
    const evidence: string[] = [];
    for (const phrase of signature.phrases) {
      const key = phrase.toLowerCase();
      let found: EvidenceTier = 'none';
      if (title.includes(key)) found = 'title';
      else if (body.includes(key)) found = 'body';
      else if (name.includes(key)) found = 'fileName';
      if (found === 'none') continue;
      evidence.push(phrase);
      if (TIER_RANK[found] > TIER_RANK[tier]) tier = found;
    }
    if (tier === 'none') continue;
    if (best === null || TIER_RANK[tier] > TIER_RANK[best.tier])
      best = { docType: signature.docType, tier, evidence };
  }

  const output: ClassifierOutput = {
    docType: best?.docType ?? 'doc_type.other',
    confidence: CLASSIFIER_CONFIDENCE[best?.tier ?? 'none'],
    evidence: distinctEvidence(best?.evidence ?? []),
  };
  const periodEnd = periodEndFrom(pageOne, fileName);
  if (periodEnd !== null && ISO_DATE.test(periodEnd)) output.periodEnd = periodEnd;
  const investment = INVESTMENT_NUMBER.exec(pageOne) ?? INVESTMENT_NUMBER.exec(fileName);
  if (investment !== null) output.investmentNumber = investment[0];
  const fromName = parseDocumentFileName(fileName);
  if (fromName !== null) output.sponsorFundName = fromName.sponsorFundName;
  return classifierOutputSchema.parse(output);
}
