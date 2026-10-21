import { describe, expect, it } from 'vitest';
import { documentCommandBody, expectedDocumentGenerateBody, ROUTES } from '@pb/contracts';
import { clearTaxonomyLabels, registerTaxonomyLabels } from '../../lib/format.js';
import {
  ageTitle,
  candidatesText,
  CLASSIFY_ROLES,
  classifiedText,
  classifyBody,
  classifyOffered,
  classifyProblem,
  confidenceText,
  dateFilter,
  dayOf,
  defaultQuarterEnd,
  docTypeLabel,
  docTypeOptions,
  EXPECTED_STATUSES,
  expectedTone,
  expectedWord,
  GENERATE_ROLES,
  generateResultText,
  hashShort,
  INDEX_ROLES,
  indexResultText,
  isExpectedStatus,
  isReviewStatus,
  keywordsText,
  mayClassify,
  mayGenerate,
  mayIndex,
  quarterEndProblem,
  REVIEW_STATUSES,
  reviewTone,
  reviewWord,
  runTone,
  sizeText,
  subjectOf,
} from './documents.js';
import {
  CONTENT_HASH,
  docTypeTaxonomyFixture,
  documentFixture,
  expectedDocumentFixture,
  scanFixture,
  statementFixture,
} from './fixtures.js';

describe('documents helpers', () => {
  it('reads the statuses from the contract and recognizes them', () => {
    expect(REVIEW_STATUSES).toEqual(['Received', 'Classified', 'NeedsReview', 'Duplicate']);
    expect(EXPECTED_STATUSES).toEqual(['expected', 'received', 'late', 'missing']);
    expect(isReviewStatus('NeedsReview')).toBe(true);
    expect(isReviewStatus('needs_review')).toBe(false);
    expect(isExpectedStatus('late')).toBe(true);
    expect(isExpectedStatus('Late')).toBe(false);
  });

  it('gives each status a tone and a word, never colour alone', () => {
    expect(reviewTone('Classified')).toBe('good');
    expect(reviewTone('NeedsReview')).toBe('watch');
    expect(reviewTone('Duplicate')).toBe('neutral');
    expect(reviewTone('Received')).toBe('neutral');
    expect(reviewWord('NeedsReview')).toBe('Needs review');
    expect(expectedTone('received')).toBe('good');
    expect(expectedTone('late')).toBe('watch');
    expect(expectedTone('missing')).toBe('bad');
    expect(expectedTone('expected')).toBe('neutral');
    expect(expectedWord('missing')).toBe('Missing');
    expect(runTone('Succeeded')).toBe('good');
    expect(runTone('Failed')).toBe('bad');
    expect(runTone('NeedsRetry')).toBe('watch');
  });

  it('labels a document type from the taxonomy, with the placeholder when untyped', () => {
    clearTaxonomyLabels();
    expect(docTypeLabel('doc_type.quarterly_financials')).toBe('Quarterly financials');
    expect(docTypeLabel(null)).toBe('-');
    registerTaxonomyLabels([{ code: 'doc_type.k1', label: 'K-1' }]);
    expect(docTypeLabel('doc_type.k1')).toBe('K-1');
    clearTaxonomyLabels();
  });

  it('lists the active doc_type terms in the taxonomy order, or nothing before it loads', () => {
    expect(docTypeOptions(undefined)).toEqual([]);
    expect(docTypeOptions(docTypeTaxonomyFixture()).map((t) => t.label)).toEqual([
      'Quarterly financials',
      'Capital call',
      'Capital account statement',
      'Other',
    ]);
  });

  it('names what a document is about: the position, else the fund, else nothing', () => {
    expect(subjectOf(documentFixture())).toEqual({
      text: 'Meridian Data Partners',
      link: { to: '/portfolio/$id', params: { id: documentFixture().investmentId } },
    });
    expect(subjectOf(statementFixture())).toEqual({
      text: 'Kelpwood Fund IV',
      link: { to: '/sponsors/$id', params: { id: statementFixture().sponsorId } },
    });
    expect(subjectOf(statementFixture({ sponsorId: null }))).toEqual({
      text: 'Kelpwood Fund IV',
      link: null,
    });
    expect(subjectOf(scanFixture())).toEqual({ text: '-', link: null });
  });

  it('shortens the hash, sizes the file and shows the confidence as a percentage', () => {
    expect(hashShort(CONTENT_HASH)).toBe('a3f1c9d2e4b5');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(9_814)).toBe('9.8 KB');
    expect(sizeText(1_250_000)).toBe('1.3 MB');
    expect(confidenceText('0.9700')).toBe('97%');
    expect(confidenceText('0.3')).toBe('30%');
    expect(confidenceText(null)).toBe('-');
    expect(dayOf('2025-07-01T09:15:00.000Z')).toBe('Jul 1, 2025');
    expect(dayOf(null)).toBe('-');
  });

  it('writes the evidence by keyword and the candidates by reason only', () => {
    expect(keywordsText({ keywords: ['quarterly report', 'period end'], candidates: [] })).toBe(
      'quarterly report, period end',
    );
    expect(keywordsText({ keywords: [], candidates: [] })).toBe('-');
    expect(candidatesText({ keywords: [], candidates: [{ reason: 'near miss' }] })).toBe(
      'near miss',
    );
    expect(candidatesText({ keywords: [], candidates: [] })).toBe('-');
  });

  it('writes the exact status phrases', () => {
    expect(indexResultText({ indexed: 77, duplicates: 1, unchanged: 0 })).toBe(
      'Indexed 77 documents, 1 duplicates, 0 unchanged',
    );
    expect(classifiedText('Quarterly financials')).toBe('Classified as Quarterly financials');
    expect(generateResultText({ periodEnd: '2025-06-30', created: 18, existing: 0 })).toBe(
      'Expected documents generated: 18 created, 0 existing',
    );
  });

  it('reads the roles of each write from the contract routes', () => {
    const roles = (path: string): readonly string[] =>
      ROUTES.find((r) => r.method === 'POST' && r.path.endsWith(path))?.roles ?? [];
    expect(INDEX_ROLES).toEqual(roles('/documents/index'));
    expect(INDEX_ROLES).toEqual(['operations']);
    expect(CLASSIFY_ROLES).toEqual(roles('/documents/{id}/commands'));
    expect(CLASSIFY_ROLES).toEqual(['deal_team', 'operations']);
    expect(GENERATE_ROLES).toEqual(['operations']);
    expect(mayIndex(['operations', 'viewer'])).toBe(true);
    expect(mayIndex(['deal_team'])).toBe(false);
    expect(mayClassify(['deal_team'])).toBe(true);
    expect(mayClassify(['viewer'])).toBe(false);
    expect(mayGenerate(['operations'])).toBe(true);
    expect(mayGenerate(['approver'])).toBe(false);
  });

  it('offers the classify form on a NeedsReview document only, to the roles the route allows', () => {
    expect(classifyOffered(['operations'], scanFixture())).toBe(true);
    expect(classifyOffered(['deal_team'], scanFixture())).toBe(true);
    expect(classifyOffered(['viewer'], scanFixture())).toBe(false);
    expect(classifyOffered(['operations'], documentFixture())).toBe(false);
    expect(classifyOffered(['operations'], documentFixture({ reviewStatus: 'Received' }))).toBe(
      false,
    );
  });

  it('refuses a classify form without a type or with a period that is not a date', () => {
    const form = {
      docType: '',
      investmentId: '',
      sponsorFundId: '',
      periodEnd: '',
      reason: '',
    };
    expect(classifyProblem(form)).toBe('Pick a document type.');
    expect(classifyProblem({ ...form, docType: 'doc_type.other' })).toBeNull();
    expect(classifyProblem({ ...form, docType: 'doc_type.other', periodEnd: '2025-06' })).toBe(
      'The period end must be a calendar date.',
    );
    expect(
      classifyProblem({ ...form, docType: 'doc_type.other', periodEnd: '2025-06-30' }),
    ).toBeNull();
  });

  it('builds the strict command body, leaving out what was left blank', () => {
    const minimal = classifyBody({
      docType: 'doc_type.other',
      investmentId: '',
      sponsorFundId: '',
      periodEnd: '',
      reason: '  ',
    });
    expect(minimal).toEqual({ command: 'classify', docType: 'doc_type.other' });
    expect(() => documentCommandBody.parse(minimal)).not.toThrow();
    const full = classifyBody({
      docType: 'doc_type.quarterly_financials',
      investmentId: documentFixture().investmentId ?? '',
      sponsorFundId: documentFixture().sponsorFundId ?? '',
      periodEnd: ' 2025-06-30 ',
      reason: 'The letterhead names the company',
    });
    expect(full).toEqual({
      command: 'classify',
      docType: 'doc_type.quarterly_financials',
      investmentId: documentFixture().investmentId,
      sponsorFundId: documentFixture().sponsorFundId,
      periodEnd: '2025-06-30',
      reason: 'The letterhead names the company',
    });
    expect(() => documentCommandBody.parse(full)).not.toThrow();
  });

  it('defaults the quarter to generate to the latest quarter end on or before the record', () => {
    expect(defaultQuarterEnd('2025-06-30')).toBe('2025-06-30');
    expect(defaultQuarterEnd('2025-08-14')).toBe('2025-06-30');
    expect(defaultQuarterEnd(undefined)).toBe('');
    expect(defaultQuarterEnd('not a date')).toBe('');
  });

  it('runs a generation for a quarter end only', () => {
    expect(quarterEndProblem('')).toBe('Pick a quarter end.');
    expect(quarterEndProblem('2025-06-15')).toBe(
      'The date must be a quarter end (March 31, June 30, September 30 or December 31).',
    );
    expect(quarterEndProblem(' 2025-06-30 ')).toBeNull();
    expect(() => expectedDocumentGenerateBody.parse({ periodEnd: '2025-06-30' })).not.toThrow();
  });

  it('applies a date filter once it is a whole calendar date', () => {
    expect(dateFilter('')).toBeUndefined();
    expect(dateFilter('2025-06')).toBeUndefined();
    expect(dateFilter('2025-06-30')).toBe('2025-06-30');
  });

  it('says the age in words for the cell title', () => {
    expect(ageTitle(expectedDocumentFixture({ status: 'expected', ageDays: -45 }))).toBe(
      '45 days before due',
    );
    expect(ageTitle(expectedDocumentFixture({ status: 'late', ageDays: 16 }))).toBe(
      '16 days past due',
    );
    expect(ageTitle(expectedDocumentFixture({ status: 'late', ageDays: 1 }))).toBe(
      '1 day past due',
    );
    expect(ageTitle(expectedDocumentFixture({ status: 'missing', ageDays: 0 }))).toBe('Due today');
    expect(ageTitle(expectedDocumentFixture({ status: 'received', ageDays: -3 }))).toBe(
      'Received 3 days before due',
    );
    expect(ageTitle(expectedDocumentFixture({ status: 'received', ageDays: 2 }))).toBe(
      'Received 2 days after due',
    );
  });
});
