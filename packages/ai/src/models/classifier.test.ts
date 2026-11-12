import { describe, expect, it } from 'vitest';
import { buildInput } from '../input.js';
import { isDocTypeCode } from '../taxonomy.js';
import {
  CLASSIFIER_CONFIDENCE,
  DOC_TYPE_SIGNATURES,
  keywordClassifier,
  parseDocumentFileName,
} from './classifier.js';

const HASH = 'b'.repeat(64);

function input(fileName: string, pages: string[]): string {
  return buildInput({
    metadata: { file_name: fileName, content_hash: HASH, page_count: pages.length },
    pages,
  });
}

describe('keywordClassifier (docs/04 M3 prototype model)', () => {
  it('classifies a quarterly report from its title at 0.97 with the period, investment number and fund', () => {
    const out = keywordClassifier(
      input(
        '2025-06-30 Harbor Growth Fund III - Quarterly financials - Harbor Logistics Group.pdf',
        [
          'Harbor Growth Fund III\nQuarterly Report\nFor the quarter ended June 30, 2025\nHarbor Logistics Group (INV-0021)',
          'Financial summary',
        ],
      ),
    );
    expect(out).toEqual({
      docType: 'doc_type.quarterly_financials',
      confidence: CLASSIFIER_CONFIDENCE.title,
      evidence: ['quarterly financials', 'quarterly report'],
      periodEnd: '2025-06-30',
      investmentNumber: 'INV-0021',
      sponsorFundName: 'Harbor Growth Fund III',
    });
  });

  it('classifies a capital call found only in the body at 0.88', () => {
    const out = keywordClassifier(
      input('notice.pdf', [
        'Harbor Growth Fund III\nNotice to Limited Partners\nJune 2, 2025\n\nThis capital call is due on 2025-06-16 for investment INV-0007.',
      ]),
    );
    expect(out.docType).toBe('doc_type.capital_call');
    expect(out.confidence).toBe(CLASSIFIER_CONFIDENCE.body);
    expect(out.evidence).toEqual(['capital call']);
    expect(out.periodEnd).toBe('2025-06-16');
    expect(out.investmentNumber).toBe('INV-0007');
    expect(out.sponsorFundName).toBeUndefined();
  });

  it('classifies a distribution notice from the file name alone at 0.6, with the fund and period from the name', () => {
    const out = keywordClassifier(
      input('2025-06-30 Harbor Growth Fund III - Distribution notice.pdf', [
        'Harbor Growth Fund III\nNotice\nPlease see the attached schedule.',
      ]),
    );
    expect(out).toEqual({
      docType: 'doc_type.distribution_notice',
      confidence: CLASSIFIER_CONFIDENCE.fileName,
      evidence: ['distribution notice'],
      periodEnd: '2025-06-30',
      sponsorFundName: 'Harbor Growth Fund III',
    });
  });

  it('classifies a capital account statement and AGM materials from their titles', () => {
    expect(
      keywordClassifier(
        input('2025-06-30 Harbor Growth Fund III - Capital account statement.pdf', [
          'Harbor Growth Fund III\nCapital Account Statement\nAs of June 30, 2025',
        ]),
      ),
    ).toMatchObject({
      docType: 'doc_type.capital_account_statement',
      confidence: '0.97',
      periodEnd: '2025-06-30',
    });
    expect(keywordClassifier(input('agenda.pdf', ['Annual Meeting 2025\nAgenda']))).toMatchObject({
      docType: 'doc_type.agm_materials',
      confidence: '0.97',
      evidence: ['annual meeting'],
    });
  });

  it('answers doc_type.other at 0.3 with no evidence for an untagged scan', () => {
    expect(keywordClassifier(input('scan_0007.pdf', ['scan\nillegible text\nno title']))).toEqual({
      docType: 'doc_type.other',
      confidence: CLASSIFIER_CONFIDENCE.none,
      evidence: [],
    });
  });

  it('breaks a tie at the same tier by table order and prefers the better tier otherwise', () => {
    // capital call sits before quarterly report in the table
    expect(
      keywordClassifier(input('x.pdf', ['Quarterly report and capital call notice'])).docType,
    ).toBe('doc_type.capital_call');
    // a title match beats a body match whatever the table order
    expect(
      keywordClassifier(
        input('x.pdf', [
          'Quarterly Report\nQ2 2025\nHarbor\n\nThe capital call of April was funded.',
        ]),
      ).docType,
    ).toBe('doc_type.quarterly_financials');
  });

  it('reads a period end from "as of Month D, YYYY" or any ISO date in page 1, else from the file name', () => {
    expect(
      keywordClassifier(input('x.pdf', ['Quarterly Letter\nas of March 31, 2025'])).periodEnd,
    ).toBe('2025-03-31');
    expect(
      keywordClassifier(input('x.pdf', ['Quarterly Letter\nreport date 2025-09-30'])).periodEnd,
    ).toBe('2025-09-30');
    expect(
      keywordClassifier(input('2025-12-31 Fund - Quarterly letter.pdf', ['Quarterly Letter']))
        .periodEnd,
    ).toBe('2025-12-31');
    expect(
      keywordClassifier(input('x.pdf', ['Quarterly Letter\nquarter ended February 30, 2025']))
        .periodEnd,
    ).toBeUndefined();
  });

  it('every signature classifies to its own type from the title and names a taxonomy code', () => {
    for (const signature of DOC_TYPE_SIGNATURES) {
      expect(isDocTypeCode(signature.docType)).toBe(true);
      const out = keywordClassifier(
        input('x.pdf', [`${signature.phrases[0]!.toUpperCase()}\nbody`]),
      );
      expect(out.docType).toBe(signature.docType);
      expect(out.confidence).toBe('0.97');
    }
    expect(new Set(DOC_TYPE_SIGNATURES.map((s) => s.docType)).size).toBe(
      DOC_TYPE_SIGNATURES.length,
    );
  });
});

describe('parseDocumentFileName (the synthetic store convention)', () => {
  it('reads investment and fund documents, and refuses other names', () => {
    expect(
      parseDocumentFileName(
        '2025-06-30 Harbor Growth Fund III - Quarterly financials - Harbor Logistics Group.pdf',
      ),
    ).toEqual({
      periodEnd: '2025-06-30',
      sponsorFundName: 'Harbor Growth Fund III',
      docTypeLabel: 'Quarterly financials',
      companyName: 'Harbor Logistics Group',
    });
    expect(
      parseDocumentFileName('2025-06-30 Harbor Growth Fund III - Capital account statement.PDF'),
    ).toEqual({
      periodEnd: '2025-06-30',
      sponsorFundName: 'Harbor Growth Fund III',
      docTypeLabel: 'Capital account statement',
      companyName: null,
    });
    expect(parseDocumentFileName('scan_0001.pdf')).toBeNull();
    expect(parseDocumentFileName('2025-02-30 Fund - Label.pdf')).toBeNull();
    expect(parseDocumentFileName('2025-06-30 Fund only.pdf')).toBeNull();
    expect(parseDocumentFileName('2025-06-30 Fund - A - B - C.pdf')).toBeNull();
    expect(parseDocumentFileName('2025-06-30 Fund - Label - .pdf')).toBeNull();
  });
});
