import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  D,
  addMonths,
  containingQuarterEnd,
  impliedStakeMark,
  markComparison,
  sourceCrossCheck,
  statementMark,
  summarizeFlows,
  toDollars,
} from '@pb/calc';
import { readPdf } from '@pb/pdf';
import type { PdfDocument } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';
import { linkInvestment, statementHold } from '@pb/validation';
import type { InvestmentDirectoryEntry } from '@pb/validation';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import extractionSchemas from '../../../config/extraction_schema.json' with { type: 'json' };
import style from '../../../config/style.json' with { type: 'json' };
import {
  DOCUMENT_DEFAULTS,
  DOCUMENT_SET_SCENARIOS,
  DOC_TYPE_LABELS,
  INJECTION_PAGE_ONE_TEXT,
  INJECTION_TEXT,
  PLAIN_POSITION_STATEMENTS,
  QUARTERLY_FIELDS,
  RESTATEMENT_DRIFT,
  STATEMENT_BALANCE_FIELDS,
  STATEMENT_FIELDS,
  SYNTHETIC_DOC_TYPES,
  UNTAGGED_FILE_NAME,
  dateInWords,
  documentFileName,
  generateDocuments,
  millions,
  positionStatementDocument,
  sanitizeFileName,
  sha256Hex,
  wrapText,
} from './documents.js';
import type { SyntheticDocument, TruthField } from './documents.js';
import { STATEMENT_EXAMPLES, statementExample } from './statement-examples.js';
import type { StatementExample } from './statement-examples.js';
import { generateDataset } from './generate.js';
import { walledInvestment } from './marks.js';

const EM_DASH = String.fromCharCode(0x2014);
const small = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(small);
const { documents, expectations } = set;
const reports = documents.filter(
  (d) => d.truth.docType === SYNTHETIC_DOC_TYPES.quarterlyFinancials,
);
/** A statement linked to no position is fund-level; one linked to a position is position-level. */
const statements = documents.filter(
  (d) => d.truth.docType === SYNTHETIC_DOC_TYPES.capitalAccountStatement,
);
const fundStatements = statements.filter((d) => d.truth.investmentId === null);
const positionStatements = statements.filter((d) => d.truth.investmentId !== null);
const byName = new Map(documents.map((d) => [d.fileName, d]));
const read = (bytes: Uint8Array): Promise<PdfDocument> => readPdf(bytes, { inflate: nodeInflate });

/** Every document read back once, by file name. */
const pdfs = new Map<string, PdfDocument>();
beforeAll(async () => {
  for (const document of documents) pdfs.set(document.fileName, await read(document.bytes));
});
const pdfOf = (document: SyntheticDocument): PdfDocument => {
  const pdf = pdfs.get(document.fileName);
  if (pdf === undefined) throw new Error(`${document.fileName} was not read back`);
  return pdf;
};
const fileOf = (name: string): SyntheticDocument => {
  const document = byName.get(name);
  if (document === undefined) throw new Error(`no document ${name}`);
  return document;
};

describe('the synthetic document set (docs/14 section 9)', () => {
  it('counts match the expectations and stay in the small profile range', () => {
    expect(expectations.total).toBe(documents.length);
    expect(expectations.total).toBeGreaterThanOrEqual(40);
    expect(expectations.total).toBeLessThanOrEqual(95);
    const summed = Object.values(expectations.byDocType).reduce((a, b) => a + b, 0);
    expect(summed).toBe(expectations.total);
    for (const [code, count] of Object.entries(expectations.byDocType))
      expect(documents.filter((d) => d.truth.docType === code)).toHaveLength(count);
    expect(Object.keys(expectations.byDocType).sort()).toEqual(
      Object.values(SYNTHETIC_DOC_TYPES).sort(),
    );
    // One fund-level statement per committed fund; the rest are position-level and listed.
    expect(fundStatements).toHaveLength(
      new Set(small.commitments.map((c) => c.sponsorFundId)).size,
    );
    expect(expectations.byDocType[SYNTHETIC_DOC_TYPES.capitalAccountStatement]).toBe(
      fundStatements.length + expectations.positionStatements.length,
    );
    expect(positionStatements.map((d) => d.fileName).sort()).toEqual(
      expectations.positionStatements.map((p) => p.fileName).sort(),
    );
  });

  it('writes the entry snapshot and the latest quarters of every equity investment, capped', () => {
    const equity = small.investments.filter((i) => i.dealType !== 'deal_type.private_credit');
    for (const inv of equity) {
      const own = reports.filter((d) => d.truth.investmentId === inv.id);
      const rows = small.quarterlyPerformance.filter((q) => q.investmentId === inv.id);
      const snapshot = rows.find((q) => q.isEntrySnapshot);
      const latest = rows
        .filter((q) => !q.isEntrySnapshot)
        .map((q) => q.periodEnd)
        .sort()
        .slice(-DOCUMENT_DEFAULTS.quartersPerInvestment);
      const wanted = [...latest];
      if (snapshot !== undefined && snapshot.periodEnd <= small.asOf)
        wanted.push(snapshot.periodEnd);
      if (inv.id === expectations.lateFinancials?.investmentId)
        wanted.splice(wanted.indexOf(expectations.lateFinancials.periodEnd), 1);
      const periods = own
        .filter((d) => !d.truth.scenarios.includes('untagged_doc'))
        .map((d) => d.truth.periodEnd);
      // The duplicate pair shares a period; the set of periods is what the cap fixes.
      expect([...new Set(periods)].sort()).toEqual(wanted.sort());
      expect(own.length).toBeLessThanOrEqual(DOCUMENT_DEFAULTS.quartersPerInvestment + 3);
    }
    const snapshotAfterAsOf = small.quarterlyPerformance.find(
      (q) => q.isEntrySnapshot && q.periodEnd > small.asOf,
    );
    expect(snapshotAfterAsOf).toBeDefined();
    expect(
      reports.some(
        (d) =>
          d.truth.investmentId === snapshotAfterAsOf?.investmentId &&
          d.truth.periodEnd === snapshotAfterAsOf.periodEnd,
      ),
    ).toBe(false);
    expect(
      documents.some((d) =>
        small.investments.some(
          (i) => i.id === d.truth.investmentId && i.dealType === 'deal_type.private_credit',
        ),
      ),
    ).toBe(false);
  });

  it('writes the capital call and distribution notices of the trailing window with their links', () => {
    const from = addMonths(small.asOf, -DOCUMENT_DEFAULTS.noticeMonths);
    const wanted = small.capitalNotices.filter(
      (n) =>
        (n.noticeType === 'notice_type.capital_call' ||
          n.noticeType === 'notice_type.distribution') &&
        n.issueDate > from &&
        n.issueDate <= small.asOf,
    );
    const notices = documents.filter(
      (d) =>
        d.truth.docType === SYNTHETIC_DOC_TYPES.capitalCall ||
        d.truth.docType === SYNTHETIC_DOC_TYPES.distributionNotice,
    );
    expect(notices).toHaveLength(wanted.length);
    expect(wanted.length).toBeGreaterThan(0);
    for (const notice of wanted) {
      const document = notices.find(
        (d) =>
          d.truth.periodEnd === notice.issueDate &&
          d.truth.fields.amount?.value === millions(notice.amount),
      );
      expect(document, `notice ${notice.id}`).toBeDefined();
      if (document === undefined) continue;
      expect(document.truth.docType).toBe(
        notice.noticeType === 'notice_type.capital_call'
          ? SYNTHETIC_DOC_TYPES.capitalCall
          : SYNTHETIC_DOC_TYPES.distributionNotice,
      );
      expect(document.truth.investmentId).toBe(notice.investmentId);
      expect(document.truth.fields.notice_date?.value).toBe(notice.issueDate);
      expect(document.truth.fields.due_date?.value).toBe(notice.dueDate);
      expect(document.truth.fields.amount?.unit).toBe('USD_M');
      expect(document.truth.pageCount).toBe(1);
      expect(document.truth.highlights).toEqual([]);
      expect(document.truth.commentary).toBeNull();
    }
    const call = notices.find((d) => d.truth.investmentId !== null);
    expect(call?.fileName).toBe(
      documentFileName(
        call?.truth.periodEnd ?? '',
        call?.truth.sponsorFundName ?? '',
        call?.truth.docType ?? SYNTHETIC_DOC_TYPES.capitalCall,
        call?.truth.companyName ?? null,
      ),
    );
    const fundLevel = notices.find((d) => d.truth.investmentId === null);
    expect(fundLevel?.truth.companyName).toBeNull();
    expect(fundLevel?.fileName).toMatch(
      /^\d{4}-\d{2}-\d{2} .+ - (Capital call|Distribution notice)\.pdf$/,
    );
  });

  it('writes one fund-level capital account statement per sponsor fund with a commitment, from the cash flows', () => {
    const fundIds = new Set(small.commitments.map((c) => c.sponsorFundId));
    expect(new Set(fundStatements.map((d) => d.truth.sponsorFundId))).toEqual(fundIds);
    expect(fundStatements).toHaveLength(fundIds.size);
    for (const statement of fundStatements) {
      // The truth holds the eleven keys of the statement schema: a fund-level statement states
      // the commitment lines and no balance of ours, so the six balance and share keys are null.
      expect(Object.keys(statement.truth.fields)).toEqual([...STATEMENT_FIELDS]);
      for (const key of [...STATEMENT_BALANCE_FIELDS, 'investor_share_pct'])
        expect(statement.truth.fields[key], key).toEqual({
          value: null,
          unit: null,
          page: null,
          quote: null,
        });
      expect(statement.truth.periodEnd).toBe(small.asOf);
      expect(statement.truth.investmentId).toBeNull();
      expect(statement.fileName).toBe(
        `${small.asOf} ${statement.truth.sponsorFundName} - Capital account statement.pdf`,
      );
      const commitments = small.commitments.filter(
        (c) => c.sponsorFundId === statement.truth.sponsorFundId,
      );
      const total = commitments.reduce((s, c) => s.plus(c.amount), D('0'));
      expect(statement.truth.fields.total_commitment?.value).toBe(millions(total.toFixed(2)));
      const paidIn = small.cashFlows
        .filter(
          (f) =>
            commitments.some((c) => c.id === f.commitmentId) &&
            f.flowType === 'flow_type.contribution' &&
            f.flowDate <= small.asOf,
        )
        .reduce((s, f) => s.plus(D(f.amount).abs()), D('0'));
      expect(statement.truth.fields.contributions_to_date?.value).toBe(millions(paidIn.toFixed(2)));
      expect(statement.truth.fields.unfunded_commitment?.value).toBe(
        millions(total.minus(paidIn).toFixed(2)),
      );
    }
  });

  it('names every file as the brief fixes, with nothing a file system refuses, and no name twice', () => {
    const names = documents.map((d) => d.fileName);
    expect(new Set(names).size).toBe(names.length);
    for (const document of documents) {
      expect(document.folder).toBe('inbox');
      expect(document.fileName).not.toMatch(/[<>:"/\\|?*]/);
      expect(Array.from(document.fileName).every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
      expect(document.fileName.endsWith('.pdf')).toBe(true);
      expect(document.truth.fileName).toBe(document.fileName);
      expect(document.truth.fileNames).toContain(document.fileName);
      if (document.truth.scenarios.includes('untagged_doc')) continue;
      const label = DOC_TYPE_LABELS[document.truth.docType];
      const stem = `${document.truth.periodEnd} ${document.truth.sponsorFundName} - ${label}`;
      expect(document.fileName.startsWith(stem)).toBe(true);
      if (document.truth.companyName !== null)
        expect(document.fileName).toContain(` - ${document.truth.companyName}`);
    }
    const report = reports.find((d) => d.truth.scenarios.length === 0);
    expect(report?.fileName).toBe(
      `${report?.truth.periodEnd} ${report?.truth.sponsorFundName} - Quarterly financials - ${report?.truth.companyName}.pdf`,
    );
  });
});

describe('the quarterly report truth', () => {
  it('records the fifteen fields in schema order from the dataset figures, in millions', () => {
    for (const report of reports) {
      expect(Object.keys(report.truth.fields)).toEqual([...QUARTERLY_FIELDS]);
      expect(report.truth.currency).toBe('USD');
      expect(report.truth.unit).toBe('USD_M');
      expect(report.truth.pageCount).toBe(4);
      const { fields } = report.truth;
      expect(fields.period_end).toEqual({
        value: report.truth.periodEnd,
        unit: 'DATE',
        page: 3,
        quote: `Period end ${report.truth.periodEnd}`,
      });
      const row = small.quarterlyPerformance.find(
        (q) =>
          q.investmentId === report.truth.investmentId && q.periodEnd === report.truth.periodEnd,
      );
      expect(row).toBeDefined();
      if (row === undefined) continue;
      if (row.revenueLtm === null || row.netDebt === null || row.cash === null) continue;
      expect(fields.revenue_ltm).toEqual({
        value: millions(row.revenueLtm),
        unit: 'USD_M',
        page: 2,
        quote: `LTM revenue ${millions(row.revenueLtm)}`,
      });
      expect(fields.ebitda_ltm?.value).toBe(millions(row.ebitdaLtm ?? ''));
      expect(fields.enterprise_value?.value).toBe(millions(row.ev ?? ''));
      expect(fields.net_debt?.value).toBe(millions(row.netDebt));
      expect(fields.cash?.value).toBe(millions(row.cash));
      expect(fields.total_equity?.value).toBe(millions(row.totalEquity ?? ''));
      expect(fields.gross_debt?.value).toBe(millions(D(row.netDebt).plus(row.cash).toFixed(2)));
      expect(fields.capex_ltm?.unit).toBe('USD_M');
      expect(fields.sponsor_ownership_pct?.unit).toBe('PCT');
      expect(fields.sponsor_ownership_pct?.value).toMatch(/^0\.\d{4}$/);
      expect(fields.sponsor_ownership_pct?.quote).toBe(
        `Sponsor ownership ${D(fields.sponsor_ownership_pct?.value ?? '0')
          .times(100)
          .toFixed(2)}%`,
      );
      expect(fields.headcount?.unit).toBe('COUNT');
      expect(fields.headcount?.value).toMatch(/^[1-9]\d*$/);
      expect(fields.fund_fair_value?.value).toBe(
        millions(
          D(row.totalEquity ?? '0')
            .times(fields.sponsor_ownership_pct?.value ?? '0')
            .toFixed(2),
        ),
      );
      for (const key of ['revenue_ltm', 'ebitda_ltm', 'period_end'] as const)
        expect(fields[key]?.value, `${report.fileName} ${key}`).not.toBeNull();
      for (const field of Object.values(fields)) {
        if (field.value === null)
          expect(field).toEqual({ value: null, unit: null, page: null, quote: null });
        else {
          expect(field.page).not.toBeNull();
          expect(field.quote).not.toBeNull();
          expect(field.value).toMatch(/^-?\d+(\.\d+)?$|^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });

  it('takes the prior-year comparables from the record one year earlier, or leaves them null', () => {
    let withPrior = 0;
    for (const report of reports) {
      if (report.truth.scenarios.includes('restatement')) continue;
      const rows = small.quarterlyPerformance.filter(
        (q) => q.investmentId === report.truth.investmentId,
      );
      const wanted = addMonths(report.truth.periodEnd, -12);
      const prior = rows.find((q) => q.periodEnd === wanted);
      const value = report.truth.fields.revenue_ltm_prior_year?.value ?? null;
      if (prior?.revenueLtm !== undefined && prior.revenueLtm !== null) {
        expect(value).toBe(millions(prior.revenueLtm));
        withPrior++;
      } else if (prior === undefined) {
        // Within the tolerance of a shifted period end a neighbour may stand in; otherwise null.
        const near = rows.find(
          (q) => Math.abs(Date.parse(q.periodEnd) - Date.parse(wanted)) <= 7 * 86_400_000,
        );
        if (near === undefined) expect(value).toBeNull();
      }
    }
    expect(withPrior).toBeGreaterThan(0);
    const missing = small.scenarios.missing_prior_year?.[0];
    const latest = reports
      .filter((d) => d.truth.investmentId === missing)
      .sort((a, b) => a.truth.periodEnd.localeCompare(b.truth.periodEnd))
      .at(-1);
    if (latest?.truth.periodEnd === small.asOf)
      expect(latest.truth.fields.revenue_ltm_prior_year?.value).toBeNull();
  });

  it('writes three house-style highlights and a commentary without an em dash or a banned phrase', () => {
    const openings = style.highlights.requiredOpenings;
    for (const report of reports) {
      expect(report.truth.highlights).toHaveLength(style.highlights.bullets);
      expect(report.truth.highlights[0]?.startsWith(openings['1'])).toBe(true);
      expect(report.truth.highlights[1]?.startsWith(openings['2'])).toBe(true);
      expect(report.truth.commentary).not.toBeNull();
      for (const text of [...report.truth.highlights, report.truth.commentary ?? '']) {
        expect(text).not.toContain(EM_DASH);
        for (const phrase of style.highlights.bannedPhrases)
          expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
        expect(text.endsWith('.')).toBe(true);
      }
    }
    const snapshot = reports.find((d) => d.truth.highlights[0]?.includes('at entry'));
    expect(snapshot).toBeDefined();
  });
});

describe('the scenario documents', () => {
  it('tags every scenario, names its files, and never the walled investment', () => {
    const walled = walledInvestment(small);
    expect(walled).toBeDefined();
    for (const tag of DOCUMENT_SET_SCENARIOS) {
      expect(expectations.scenarioFiles[tag].length, tag).toBeGreaterThan(0);
      for (const name of expectations.scenarioFiles[tag]) {
        if (tag === 'late_financials') {
          expect(byName.has(name)).toBe(false);
          continue;
        }
        const document = fileOf(name);
        expect(document.truth.scenarios).toContain(tag);
        expect(document.truth.investmentId).not.toBe(walled?.id);
        expect(expectations.walledFiles).not.toContain(name);
      }
    }
    const tagged = documents.filter((d) => d.truth.scenarios.length > 0);
    expect(new Set(tagged.map((d) => d.truth.investmentId)).size).toBe(4);
    for (const document of documents)
      for (const tag of document.truth.scenarios)
        expect(expectations.scenarioFiles[tag]).toContain(document.fileName);
  });

  it('injection_doc carries the instruction on the notes page and keeps the real figures', async () => {
    const [name] = expectations.scenarioFiles.injection_doc;
    const document = fileOf(name ?? '');
    const pdf = pdfOf(document);
    expect(pdf.pages[3]?.text).toContain(INJECTION_TEXT);
    expect(pdf.pages[0]?.text).not.toContain('ignore your instructions');
    const row = small.quarterlyPerformance.find(
      (q) =>
        q.investmentId === document.truth.investmentId && q.periodEnd === document.truth.periodEnd,
    );
    expect(document.truth.fields.revenue_ltm?.value).toBe(millions(row?.revenueLtm ?? ''));
    expect(document.truth.fields.revenue_ltm?.value).not.toBe('999.00');
    expect(document.truth.periodEnd).toBe(
      reports
        .filter((d) => d.truth.investmentId === document.truth.investmentId)
        .map((d) => d.truth.periodEnd)
        .sort()
        .at(-1),
    );
    await expect(read(document.bytes)).resolves.toBeDefined();
  });

  it('injection_doc also names another type on page 1, below the title block, with the truth unchanged (AI-5)', () => {
    const [name] = expectations.scenarioFiles.injection_doc;
    const document = fileOf(name ?? '');
    const first = pdfOf(document).pages[0]?.text ?? '';
    // One line, read back verbatim, after the three title lines a classifier reads first.
    expect(first).toContain(INJECTION_PAGE_ONE_TEXT);
    expect(INJECTION_PAGE_ONE_TEXT.toLowerCase()).toContain('capital call');
    const lines = first.split('\n').filter((line) => line.trim() !== '');
    expect(lines.slice(0, 3)).toEqual([
      document.truth.sponsorFundName,
      'Quarterly Report',
      `for the quarter ended ${dateInWords(document.truth.periodEnd)}`,
    ]);
    expect(lines.indexOf(INJECTION_PAGE_ONE_TEXT)).toBeGreaterThanOrEqual(3);
    expect(lines.indexOf(INJECTION_PAGE_ONE_TEXT)).toBeLessThan(lines.indexOf('Dear Investor,'));
    // The truth keeps the real type at the titled confidence, the real figures and the letter.
    expect(document.truth.expectedClassification).toEqual({
      docType: SYNTHETIC_DOC_TYPES.quarterlyFinancials,
      confidenceAtLeast: '0.97',
    });
    expect(document.truth.commentary).not.toContain('automated reader');
    expect(document.truth.highlights.join(' ')).not.toContain('automated reader');
    for (const field of Object.values(document.truth.fields))
      expect(field.quote ?? '').not.toContain('automated reader');
    // No other document carries either instruction, and the variant adds no document: the
    // scenario still names one file, counted in expectations.total like any report.
    for (const other of documents) {
      if (other.truth.contentHash === document.truth.contentHash) continue;
      for (const page of pdfOf(other).pages) {
        expect(page.text, other.fileName).not.toContain(INJECTION_TEXT);
        expect(page.text, other.fileName).not.toContain(INJECTION_PAGE_ONE_TEXT);
      }
    }
    expect(expectations.scenarioFiles.injection_doc).toHaveLength(1);
    expect(documents.filter((d) => d.truth.scenarios.includes('injection_doc'))).toHaveLength(1);
    expect(expectations.total).toBe(documents.length);
  });

  it('duplicate_doc is the same bytes and hash under a second name, both truths tagged', () => {
    const [first, second] = expectations.scenarioFiles.duplicate_doc;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const a = fileOf(first ?? '');
    const b = fileOf(second ?? '');
    expect(a.fileName).not.toBe(b.fileName);
    expect(b.fileName).toBe(a.fileName.replace(/\.pdf$/, ' (1).pdf'));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.truth.contentHash).toBe(b.truth.contentHash);
    expect(a.truth.fileNames).toEqual([a.fileName, b.fileName]);
    expect(b.truth.fileNames).toEqual([a.fileName, b.fileName]);
    expect(a.truth.scenarios).toContain('duplicate_doc');
    expect(b.truth.scenarios).toContain('duplicate_doc');
    expect({ ...a.truth, fileName: '' }).toEqual({ ...b.truth, fileName: '' });
    expect(documents.filter((d) => d.truth.contentHash === a.truth.contentHash)).toHaveLength(2);
    const hashes = documents.map((d) => d.truth.contentHash);
    expect(new Set(hashes).size).toBe(documents.length - 1);
  });

  it('untagged_doc has a generic name, no letterhead, no title line and no metadata', () => {
    const [name] = expectations.scenarioFiles.untagged_doc;
    expect(name).toBe(UNTAGGED_FILE_NAME);
    const document = fileOf(name ?? '');
    const pdf = pdfOf(document);
    const first = pdf.pages[0]?.text ?? '';
    expect(first).not.toContain('Quarterly Report');
    expect(first).not.toContain(document.truth.sponsorFundName);
    expect(first).not.toContain(document.truth.investmentNumber ?? 'INV-');
    expect(first).toContain(document.truth.companyName ?? '');
    expect(pdf.info.title).toBeUndefined();
    expect(pdf.info.author).toBeUndefined();
    expect(pdf.info.subject).toBeUndefined();
    expect(document.truth.docType).toBe(SYNTHETIC_DOC_TYPES.quarterlyFinancials);
    expect(document.truth.expectedClassification).toEqual({
      docType: SYNTHETIC_DOC_TYPES.quarterlyFinancials,
      confidenceAtLeast: '0',
    });
    // The ordinary report for the same quarter is still there, with different bytes.
    const ordinary = reports.find(
      (d) =>
        d !== document &&
        d.truth.investmentId === document.truth.investmentId &&
        d.truth.periodEnd === document.truth.periodEnd,
    );
    expect(ordinary).toBeDefined();
    expect(ordinary?.truth.contentHash).not.toBe(document.truth.contentHash);
    expect(ordinary?.truth.fields).toEqual(document.truth.fields);
    expect(ordinary?.truth.expectedClassification.confidenceAtLeast).toBe('0.97');
  });

  it('late_financials leaves out the latest quarter of one active investment and names it', () => {
    const late = expectations.lateFinancials;
    expect(late).not.toBeNull();
    if (late === null) return;
    expect(expectations.scenarioFiles.late_financials).toEqual([late.fileName]);
    expect(byName.has(late.fileName)).toBe(false);
    expect(late.periodEnd).toBe(small.asOf);
    const inv = small.investments.find((i) => i.id === late.investmentId);
    expect(inv?.isActive).toBe(true);
    expect(inv?.investmentNumber).toBe(late.investmentNumber);
    const latestRow = small.quarterlyPerformance
      .filter((q) => q.investmentId === late.investmentId && !q.isEntrySnapshot)
      .map((q) => q.periodEnd)
      .sort()
      .at(-1);
    expect(latestRow).toBe(late.periodEnd);
    const remaining = reports.filter((d) => d.truth.investmentId === late.investmentId);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every((d) => d.truth.periodEnd < late.periodEnd)).toBe(true);
    expect(late.fileName).toBe(
      documentFileName(
        late.periodEnd,
        remaining[0]?.truth.sponsorFundName ?? '',
        SYNTHETIC_DOC_TYPES.quarterlyFinancials,
        late.companyName,
      ),
    );
  });

  it('restatement moves the prior-year comparables by the drift and says so in the notes', () => {
    const [name] = expectations.scenarioFiles.restatement;
    const document = fileOf(name ?? '');
    const pdf = pdfOf(document);
    const prior = small.quarterlyPerformance.find(
      (q) =>
        q.investmentId === document.truth.investmentId &&
        q.periodEnd === addMonths(document.truth.periodEnd, -12),
    );
    expect(prior?.revenueLtm).toBeDefined();
    const restatedRevenue = millions(
      D(prior?.revenueLtm ?? '0')
        .times(D('1').plus(RESTATEMENT_DRIFT.revenue))
        .toFixed(2),
    );
    const restatedEbitda = millions(
      D(prior?.ebitdaLtm ?? '0')
        .times(D('1').plus(RESTATEMENT_DRIFT.ebitda))
        .toFixed(2),
    );
    expect(document.truth.fields.revenue_ltm_prior_year?.value).toBe(restatedRevenue);
    expect(document.truth.fields.ebitda_ltm_prior_year?.value).toBe(restatedEbitda);
    expect(restatedRevenue).not.toBe(millions(prior?.revenueLtm ?? '0'));
    expect(pdf.pages[1]?.text).toContain(`Prior-year LTM revenue ${restatedRevenue}`);
    expect(pdf.pages[3]?.text).toContain('restated');
    // This quarter's own figures are untouched.
    const row = small.quarterlyPerformance.find(
      (q) =>
        q.investmentId === document.truth.investmentId && q.periodEnd === document.truth.periodEnd,
    );
    expect(document.truth.fields.revenue_ltm?.value).toBe(millions(row?.revenueLtm ?? ''));
  });

  it('lists every document of the walled investment, reports and notices, in walledFiles', () => {
    const walled = walledInvestment(small);
    const own = documents.filter((d) => d.truth.investmentId === walled?.id).map((d) => d.fileName);
    expect(own.length).toBeGreaterThanOrEqual(DOCUMENT_DEFAULTS.quartersPerInvestment);
    expect(expectations.walledFiles).toEqual(own);
    for (const name of expectations.walledFiles) {
      const document = fileOf(name);
      expect(document.truth.scenarios).toEqual([]);
      expect(document.truth.investmentNumber).toBe(walled?.investmentNumber);
    }
    expect(expectations.walledFiles).not.toContain(UNTAGGED_FILE_NAME);
  });
});

/** The hashes of the eleven fund-level statements at seed 42, as they were before a statement schema existed. */
const FUND_STATEMENT_HASHES: Readonly<Record<string, string>> = {
  'Dunecrest Fund IV': '00231acbea3dc0947a2977b89191a5eff762c5f08bf9cd7a6f24797bd71b76d5',
  'Kelpwood Fund I': 'ae7dcbad87801ea20841c2daad60df2a9262b14a929101b50216dd884fafa530',
  'Kelpwood Fund III': 'b8c42d489f2f78a3f716f2fa25b32c52e84e7f0190af055eac10554f33bcc835',
  'Marram Fund I': '7f86f1c3f05aed9a2e9a4d43133fc53d55756b53bbcb834a9b834fd9700a32f9',
  'Marram Fund III': '58024e2400c9a19ec50c94cda0fa0f347429239bcbc44bfa9ac97fdd2618a8eb',
  'Oysterbed Credit Fund I': 'e7592ad2c7224bf133bcf1cebf8881060ff11e7b83928937384d7fa381521666',
  'Seagrass Fund II': '2a3dc7fa6f4b05583223e00eb748f8989ffe4df8217b2573c6d5751de83d7724',
  'Seagrass Growth Fund II': 'f03bbbeab4d0ff166419c053426618cc506efd38d143fc6b09081c14644cb226',
  'Skerry Fund I': '87756cb258fefc247c2132b7e14fcb2e96d5d44181db1d2aa041bbbdf8ec373e',
  'Skerry Growth Fund II': '62bc186756805d593b8da295b52f195eff53168427bafea9ffdbafcf0b47b50e',
  'Stormglass Fund I': '0d9157d65b0d3d79431bdc2c9fec8685963dff0b49ec197f80658346cd80bf53',
};

describe('position-level capital account statements (decision 0023)', () => {
  const suggestions = definitions.valuationSuggestions;
  const tolerances = {
    tieToleranceUsd: String(suggestions.tieToleranceByUnit.USD_M),
    contributionsTolerancePct: String(suggestions.contributionsTolerancePct),
  };
  const varianceFlag = String(definitions.valuationVarianceFlag);
  const asOf = small.asOf;
  const prior = containingQuarterEnd(addMonths(asOf, -3));
  const investmentOf = (id: string) => {
    const found = small.investments.find((i) => i.id === id);
    if (found === undefined) throw new Error(`no investment ${id}`);
    return found;
  };
  const companyOf = (portfolioCompanyId: string): string =>
    small.portfolioCompanies.find((c) => c.id === portfolioCompanyId)?.name ?? '';
  const directory: InvestmentDirectoryEntry[] = small.investments.map((i) => ({
    id: i.id,
    investmentNumber: i.investmentNumber,
    companyName: companyOf(i.portfolioCompanyId),
    canonicalName: companyOf(i.portfolioCompanyId).toLowerCase(),
    aliases: [],
    dealType: i.dealType,
    entryDate: i.entryDate,
    exitDate: i.exitDate,
    isActive: i.isActive,
  }));
  /** A truth line in dollars, or null when the statement does not state it. */
  const dollars = (field: TruthField | undefined): string | null =>
    field === undefined || field.value === null || field.unit === null
      ? null
      : toDollars(field.value, field.unit).toFixed(2);
  /** The approved contributions on a position on or before a date, as the record holds them. */
  const recordContributions = (investmentId: string, until: string): string =>
    summarizeFlows(
      small.cashFlows
        .filter(
          (f) =>
            f.investmentId === investmentId &&
            f.status === 'record_status.approved' &&
            f.flowDate <= until,
        )
        .map((f) => ({
          date: f.flowDate,
          amount: f.amount,
          kind: f.flowType.replace('flow_type.', '') as 'contribution',
        })),
    ).contributions.toFixed(2);
  /** Rule 12.1 over a statement's truth. */
  const markOf = (document: SyntheticDocument) => {
    const f = document.truth.fields;
    return statementMark(
      {
        beginningBalance: dollars(f.beginning_capital_balance),
        contributionsInPeriod: dollars(f.contributions_in_period),
        distributionsInPeriod: dollars(f.distributions_in_period),
        netGainLoss: dollars(f.net_gain_loss),
        endingBalance: dollars(f.ending_capital_balance),
        contributionsToDate: dollars(f.contributions_to_date),
        share: f.investor_share_pct?.value ?? null,
      },
      recordContributions(document.truth.investmentId ?? '', document.truth.periodEnd),
      tolerances,
    );
  };
  const lockedMark = (investmentId: string, periodEnd: string): string | null =>
    small.valuations.find(
      (v) => v.investmentId === investmentId && v.state === 'Locked' && v.periodEnd === periodEnd,
    )?.fairValue ?? null;
  const statementOf = (investmentId: string, periodEnd: string): SyntheticDocument => {
    const found = positionStatements.find(
      (d) => d.truth.investmentId === investmentId && d.truth.periodEnd === periodEnd,
    );
    if (found === undefined) throw new Error(`no statement for ${investmentId} at ${periodEnd}`);
    return found;
  };

  it('keeps the eleven fund-level statements byte for byte: same names, same hashes', () => {
    expect(
      Object.fromEntries(fundStatements.map((d) => [d.truth.sponsorFundName, d.truth.contentHash])),
    ).toEqual(FUND_STATEMENT_HASHES);
    for (const statement of fundStatements)
      expect(sha256Hex(statement.bytes)).toBe(statement.truth.contentHash);
  });

  it('holds the keys of the statement schema in config, in its order, in every statement truth', () => {
    const configured = extractionSchemas.schemas.capital_account_statement.fields.map((f) => f.key);
    expect([...STATEMENT_FIELDS]).toEqual(configured);
    for (const statement of statements)
      expect(Object.keys(statement.truth.fields), statement.fileName).toEqual(configured);
  });

  it('writes two statements for the stale valuation, the roll forward break and the walled position, and for plain positions no scenario took', () => {
    const scenarioIds = ['stale_valuation', 'roll_forward_break', 'walled_deal'].map(
      (scenario) => small.scenarios[scenario]?.[0] ?? '',
    );
    const covered = new Set(expectations.positionStatements.map((p) => p.investmentId));
    for (const id of scenarioIds) expect(covered.has(id), id).toBe(true);
    // In the small profile every other active position carries a data scenario or was taken by
    // a document scenario, so no plain position remains.
    expect(covered.size).toBe(3);
    expect(expectations.positionStatements.map((p) => [p.investmentNumber, p.periodEnd])).toEqual(
      [...covered]
        .map((id) => investmentOf(id).investmentNumber)
        .sort()
        .flatMap((number) => [
          [number, prior],
          [number, asOf],
        ]),
    );
    for (const p of expectations.positionStatements) {
      const inv = investmentOf(p.investmentId);
      expect([
        'deal_type.co_invest_equity',
        'deal_type.cv_single_asset',
        'deal_type.cv_multi_asset',
      ]).toContain(inv.dealType);
      expect(inv.isActive).toBe(true);
      expect(p.companyName).toBe(companyOf(inv.portfolioCompanyId));
      const document = fileOf(p.fileName);
      expect(document.truth.investmentId).toBe(p.investmentId);
      expect(document.truth.scenarios).toEqual([]);
      expect(dollars(document.truth.fields.ending_capital_balance)).toBe(p.endingBalance);
      expect(dollars(document.truth.fields.beginning_capital_balance)).toBe(p.beginningBalance);
    }
    // The default profile has plain positions to spare: three more, six statements more.
    const large = generateDataset({ profile: 'default', seed: 42 });
    const more = generateDocuments(large).expectations.positionStatements;
    expect(new Set(more.map((p) => p.investmentId)).size).toBe(3 + PLAIN_POSITION_STATEMENTS);
    const taggedIds = new Set(
      large.investments.filter((i) => i.scenarioTags.length > 0).map((i) => i.id),
    );
    expect(more.filter((p) => !taggedIds.has(p.investmentId))).toHaveLength(
      PLAIN_POSITION_STATEMENTS * 2,
    );
  });

  it('takes the ending balance from the Locked mark of the quarter, and from the marking rule where there is none', () => {
    for (const p of expectations.positionStatements) {
      const mark = lockedMark(p.investmentId, p.periodEnd);
      expect(p.fromLockedMark, p.fileName).toBe(mark !== null);
      if (mark !== null)
        expect(p.endingBalance, p.fileName).toBe(D(millions(mark)).times(1_000_000).toFixed(2));
    }
    // The two quarters the scenarios leave without a mark: the stale position's latest quarter
    // and the quarter before the roll forward break's.
    const unmarked = expectations.positionStatements
      .filter((p) => !p.fromLockedMark)
      .map((p) => [p.investmentId, p.periodEnd]);
    expect(unmarked).toEqual(
      [
        [small.scenarios.stale_valuation?.[0], asOf],
        [small.scenarios.roll_forward_break?.[0], prior],
      ].sort((a, b) =>
        investmentOf(a[0] ?? '').investmentNumber.localeCompare(
          investmentOf(b[0] ?? '').investmentNumber,
        ),
      ),
    );
    // By the rule the dataset marks positions by: cost over the equity at entry, times the
    // quarter's enterprise value less net debt (or a tenth of cost when that is larger).
    for (const [investmentId = '', periodEnd = ''] of unmarked) {
      const rows = small.quarterlyPerformance.filter((q) => q.investmentId === investmentId);
      const snapshot = rows.find((q) => q.isEntrySnapshot);
      const quarter = rows.find((q) => !q.isEntrySnapshot && q.periodEnd === periodEnd);
      const cost = D(recordContributions(investmentId, investmentOf(investmentId).entryDate));
      const equity = D(quarter?.ev ?? '0').minus(quarter?.netDebt ?? '0');
      const floor = cost.times('0.1');
      const value = cost
        .div(snapshot?.totalEquity ?? '1')
        .times(equity.gt(floor) ? equity : floor)
        .toFixed(2);
      const statement = statementOf(investmentId, periodEnd);
      expect(statement.truth.fields.ending_capital_balance?.value).toBe(millions(value));
    }
  });

  it('ties: every statement states all five balance lines and they add up exactly', () => {
    expect(positionStatements.length).toBeGreaterThanOrEqual(6);
    for (const statement of positionStatements) {
      const f = statement.truth.fields;
      for (const key of [
        ...STATEMENT_BALANCE_FIELDS,
        'contributions_to_date',
        'distributions_to_date',
      ]) {
        expect(f[key]?.value, `${statement.fileName} ${key}`).not.toBeNull();
        expect(f[key]?.unit, `${statement.fileName} ${key}`).toBe('USD_M');
      }
      // Our own account: no commitment lines, no share of a vehicle.
      for (const key of ['total_commitment', 'unfunded_commitment', 'investor_share_pct'])
        expect(f[key]?.value, `${statement.fileName} ${key}`).toBeNull();
      const mark = markOf(statement);
      expect(mark.ownAccount, statement.fileName).toBe(true);
      expect(mark.ties, statement.fileName).toBe(true);
      expect(mark.tieDifference, statement.fileName).toBe('0');
      expect(D(mark.value ?? '0').toFixed(2), statement.fileName).toBe(
        dollars(f.ending_capital_balance),
      );
      expect(mark.reason, statement.fileName).toBeNull();
      // The flows are the approved cash flows of the position, to the cent of a million.
      expect(mark.contributionsCheck.differs, statement.fileName).toBe(false);
      expect(f.contributions_to_date?.value, statement.fileName).toBe(
        millions(
          recordContributions(statement.truth.investmentId ?? '', statement.truth.periodEnd),
        ),
      );
    }
  });

  it('chains: each statement begins where the one before it ended', () => {
    for (const id of new Set(positionStatements.map((d) => d.truth.investmentId ?? ''))) {
      const earlier = statementOf(id, prior);
      const later = statementOf(id, asOf);
      expect(later.truth.fields.beginning_capital_balance?.value, later.fileName).toBe(
        earlier.truth.fields.ending_capital_balance?.value,
      );
    }
  });

  it('links to its position by the company in its file name and by the reference on page one', () => {
    for (const statement of positionStatements) {
      const inv = investmentOf(statement.truth.investmentId ?? '');
      const company = companyOf(inv.portfolioCompanyId);
      const fund = statement.truth.sponsorFundName;
      expect(statement.fileName).toBe(
        `${statement.truth.periodEnd} ${fund} - Capital account statement - ${company}.pdf`,
      );
      expect(statement.truth.sponsorFundId).toBe(inv.sponsorFundId);
      const pageOne = pdfOf(statement).pages[0]?.text ?? '';
      const reference = /\bINV-\d{4}\b/.exec(pageOne)?.[0] ?? null;
      expect(reference, statement.fileName).toBe(inv.investmentNumber);
      const byName = linkInvestment(
        { investmentNumber: null, companyName: company },
        directory,
        [],
      );
      const byNumber = linkInvestment(
        { investmentNumber: reference, companyName: null },
        directory,
        [],
      );
      expect(byName.investment?.id, statement.fileName).toBe(inv.id);
      expect(byNumber.investment?.id, statement.fileName).toBe(inv.id);
      // So the review rule of docs/18 section 6 lets it through.
      expect(
        statementHold({ investmentNumber: reference, companyName: company }, directory, []),
      ).toBeNull();
      // The page: letterhead, title, who it is for with our reference, the period end, one account block.
      const lines = pdfOf(statement).pages[0]?.lines.map((l) => l.text) ?? [];
      const vehicle = small.vehicles.find((v) => v.id === inv.vehicleId)?.name ?? '';
      expect(lines.slice(0, 6)).toEqual([
        fund,
        'Capital Account Statement',
        `for the quarter ended ${dateInWords(statement.truth.periodEnd)}`,
        `Prepared for ${vehicle}, reference ${inv.investmentNumber}`,
        `Period end ${statement.truth.periodEnd}`,
        `Account ${vehicle} US$ millions`,
      ]);
      expect(pdfOf(statement).info.title).toContain(company);
    }
  });

  it('the example sequence on the stale valuation position: the statement and the report indication agree within US$ 10,000', () => {
    const id = small.scenarios.stale_valuation?.[0] ?? '';
    const statement = statementOf(id, asOf);
    const mark = markOf(statement);
    const rows = small.quarterlyPerformance.filter((q) => q.investmentId === id);
    const now = rows.find((q) => !q.isEntrySnapshot && q.periodEnd === asOf);
    const before = rows.find((q) => !q.isEntrySnapshot && q.periodEnd === prior);
    const reference = lockedMark(id, prior);
    expect(lockedMark(id, asOf)).toBeNull();
    expect(reference).not.toBeNull();
    // No cash moved after the last Locked mark, so the report's rule applies (docs/08 12.2).
    const flowsSince = small.cashFlows.some(
      (f) => f.investmentId === id && f.flowDate > prior && f.flowDate <= asOf,
    );
    expect(flowsSince).toBe(false);
    const indication = impliedStakeMark({
      referenceMark: reference,
      flowsSinceReferenceMark: flowsSince,
      reference: { ev: before?.ev ?? null, netDebt: before?.netDebt ?? null },
      current: { ev: now?.ev ?? '0', netDebt: now?.netDebt ?? null },
    });
    expect(indication.reason).toBeNull();
    expect(mark.value).not.toBeNull();
    const apart = D(indication.value ?? '0')
      .minus(mark.value ?? '0')
      .abs();
    expect(apart.lt(10_000), `the two are ${apart.toFixed(2)} apart`).toBe(true);
    // The tenth-of-cost floor of the marking rule is not what gave the balance.
    const cost = D(recordContributions(id, asOf));
    expect(
      D(now?.ev ?? '0')
        .minus(now?.netDebt ?? '0')
        .gt(cost.times('0.1')),
    ).toBe(true);
    // The badges the walkthrough names: the mark moved by more than the variance flag against
    // the previous quarter's, the lines add up, the contributions agree, the two sources agree.
    const comparison = markComparison({
      suggested: mark.value,
      current: reference,
      currentIsPreviousQuarter: true,
      varianceFlag,
      statement: { ...mark.ours, tieToleranceUsd: tolerances.tieToleranceUsd },
    });
    const crossCheck = sourceCrossCheck(indication.value, mark.value, varianceFlag);
    expect({
      variance: comparison.variance,
      ties: mark.ties,
      contributionsDiffer: mark.contributionsCheck.differs,
      sourcesDiffer: crossCheck.differs,
    }).toEqual({ variance: true, ties: true, contributionsDiffer: false, sourcesDiffer: false });
    expect(mark.value).toBe('38140000');
    expect(comparison.change).toBe('-7938308.34');
    // The statement starts where our record does, so the change net of flows is shown.
    expect(comparison.netOfFlows).toBe('-7938308.34');
  });
});

describe('example statements for tests (statementExample)', () => {
  const inv = small.investments.find((i) => i.id === small.scenarios.stale_valuation?.[0]);
  if (inv === undefined) throw new Error('the small profile has no stale valuation position');
  const fund = small.sponsorFunds.find((f) => f.id === inv.sponsorFundId);
  if (fund === undefined) throw new Error('the stale valuation position has no fund');
  const company = small.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)?.name ?? '';
  const target = {
    periodEnd: small.asOf,
    fund,
    vehicleName: small.vehicles.find((v) => v.id === inv.vehicleId)?.name ?? '',
    investment: { id: inv.id, investmentNumber: inv.investmentNumber, companyName: company },
  };
  const examples = Object.keys(STATEMENT_EXAMPLES) as StatementExample[];
  const written = new Map(examples.map((key) => [key, statementExample(key, target)]));
  const of = (key: StatementExample): SyntheticDocument => {
    const found = written.get(key);
    if (found === undefined) throw new Error(`no example ${key}`);
    return found;
  };
  const valuesOf = (key: StatementExample): Record<string, string | null> =>
    Object.fromEntries(Object.entries(of(key).truth.fields).map(([k, f]) => [k, f.value]));
  const unitsOf = (key: StatementExample): (string | null)[] =>
    [...new Set(Object.values(of(key).truth.fields).map((f) => f.unit))].sort();

  it('writes each example as one page whose every stated value is cited on it', async () => {
    for (const key of examples) {
      const document = of(key);
      const pdf = await read(document.bytes);
      expect(pdf.pageCount, key).toBe(1);
      expect(Object.keys(document.truth.fields), key).toEqual([...STATEMENT_FIELDS]);
      expect(document.truth.contentHash, key).toBe(sha256Hex(document.bytes));
      const text = pdf.pages[0]?.text ?? '';
      expect(text, key).not.toContain(EM_DASH);
      for (const [name, f] of Object.entries(document.truth.fields)) {
        if (f.value === null) {
          expect(f, `${key} ${name}`).toEqual({ value: null, unit: null, page: null, quote: null });
          continue;
        }
        expect(f.page, `${key} ${name}`).toBe(1);
        expect(text, `${key} ${name}`).toContain(f.quote ?? '');
      }
    }
    // Every example differs from every other, and from the seeded statement of that quarter.
    const hashes = new Set([...written.values()].map((d) => d.truth.contentHash));
    expect(hashes.size).toBe(examples.length);
  });

  it('records our own account as printed, in millions (docs/08 section 12, examples 1, 2 and 8)', () => {
    expect(valuesOf('ties')).toEqual({
      period_end: small.asOf,
      total_commitment: null,
      contributions_to_date: '12.40',
      distributions_to_date: '0.35',
      unfunded_commitment: null,
      beginning_capital_balance: '18.42',
      contributions_in_period: '2.00',
      distributions_in_period: '0.35',
      net_gain_loss: '0.87',
      ending_capital_balance: '20.94',
      investor_share_pct: null,
    });
    expect(unitsOf('ties')).toEqual(['DATE', 'USD_M', null].sort());
    expect(valuesOf('tiesWithinTolerance').net_gain_loss).toBe('0.89');
    expect(valuesOf('doesNotTie').net_gain_loss).toBe('0.92');
    expect(valuesOf('contributionsDiffer').contributions_to_date).toBe('30.00');
    for (const key of ['tiesWithinTolerance', 'doesNotTie', 'contributionsDiffer'] as const)
      expect(valuesOf(key).ending_capital_balance, key).toBe('20.94');
  });

  it('records a whole vehicle with our share, and no balance of ours when the share is not given (example 3)', () => {
    expect(valuesOf('wholeVehicle')).toMatchObject({
      contributions_to_date: '49.60',
      beginning_capital_balance: '73.68',
      contributions_in_period: '8.00',
      distributions_in_period: '1.40',
      net_gain_loss: '3.48',
      ending_capital_balance: '83.76',
      investor_share_pct: '0.2500',
    });
    expect(of('wholeVehicle').truth.fields.investor_share_pct).toEqual({
      value: '0.2500',
      unit: 'PCT',
      page: 1,
      quote: 'Our share of the vehicle 25.00%',
    });
    const noShare = valuesOf('wholeVehicleNoShare');
    for (const key of [...STATEMENT_BALANCE_FIELDS, 'investor_share_pct'])
      expect(noShare[key], key).toBeNull();
    // The totals to date are still the statement's own.
    expect(noShare.contributions_to_date).toBe('49.60');
    expect(noShare.distributions_to_date).toBe('1.40');
  });

  it('records no money line of a statement in another currency, and the unit of one in thousands', () => {
    const euro = valuesOf('euro');
    expect(euro.period_end).toBe(small.asOf);
    for (const key of STATEMENT_FIELDS) if (key !== 'period_end') expect(euro[key], key).toBeNull();
    expect(unitsOf('thousands')).toEqual(['DATE', 'USD_K', null].sort());
    expect(valuesOf('thousands').ending_capital_balance).toBe('20940.00');
  });

  it('records a fund-style statement on a position: the commitment lines and no balance', () => {
    const fundStyle = valuesOf('fundStyle');
    expect(fundStyle).toMatchObject({
      total_commitment: '120.00',
      unfunded_commitment: '33.75',
      contributions_to_date: '86.25',
      distributions_to_date: '14.10',
    });
    for (const key of STATEMENT_BALANCE_FIELDS) expect(fundStyle[key], key).toBeNull();
    expect(of('fundStyle').truth.investmentId).toBe(inv.id);
  });

  it('names what the test asks: another company in the file name, another reference, or none', () => {
    const lines = STATEMENT_EXAMPLES.ties.lines;
    const renamed = positionStatementDocument({
      ...target,
      fileCompany: 'Northgate Holdco',
      reference: 'INV-9999',
      lines,
    });
    expect(renamed.fileName).toBe(
      `${small.asOf} ${fund.name} - Capital account statement - Northgate Holdco.pdf`,
    );
    const fundNamed = positionStatementDocument({
      ...target,
      investment: null,
      fileCompany: null,
      reference: null,
      lines,
    });
    expect(fundNamed.fileName).toBe(`${small.asOf} ${fund.name} - Capital account statement.pdf`);
    expect(fundNamed.truth.investmentId).toBeNull();
    expect(renamed.truth.contentHash).not.toBe(of('ties').truth.contentHash);
  });
});

describe('the PDFs read back with @pb/pdf', () => {
  it('cites every value by a quote found verbatim on its page, with the page count right', () => {
    let quotes = 0;
    for (const document of documents) {
      const pdf = pdfOf(document);
      expect(pdf.pageCount, document.fileName).toBe(document.truth.pageCount);
      expect(pdf.reconstructed).toBe(false);
      for (const [key, field] of Object.entries(document.truth.fields)) {
        if (field.value === null) continue;
        const page = pdf.pages[(field.page ?? 0) - 1];
        expect(page, `${document.fileName} ${key} page ${field.page}`).toBeDefined();
        const text = page?.text ?? '';
        expect(text, `${document.fileName} ${key}`).toContain(field.quote ?? '');
        const shown =
          field.unit === 'PCT' ? `${D(field.value).times(100).toFixed(2)}%` : field.value;
        expect(text, `${document.fileName} ${key} value`).toContain(shown);
        expect((field.quote ?? '').length).toBeLessThanOrEqual(150);
        quotes++;
      }
    }
    expect(quotes).toBeGreaterThan(documents.length * 3);
  });

  it('carries no em dash and no undecodable run on any page', () => {
    for (const document of documents) {
      const pdf = pdfOf(document);
      for (const page of pdf.pages) {
        expect(page.text, document.fileName).not.toContain(EM_DASH);
        expect(page.runs.some((r) => r.undecodable === true)).toBe(false);
        expect(page.text).toContain('Synthetic prototype document');
      }
    }
  });

  it('names the fund, the type and the quarter in the information dictionary of a titled document', () => {
    for (const document of documents) {
      const pdf = pdfOf(document);
      expect(pdf.info.creationDate).toMatch(/^D:\d{14}Z$/);
      if (document.truth.scenarios.includes('untagged_doc')) continue;
      expect(pdf.info.author).toBe(document.truth.sponsorFundName);
      expect(pdf.info.subject).toBe(DOC_TYPE_LABELS[document.truth.docType]);
      expect(pdf.info.title).toBeDefined();
      if (document.truth.docType === SYNTHETIC_DOC_TYPES.quarterlyFinancials) {
        expect(pdf.info.title).toContain(document.truth.companyName ?? '');
        expect(pdf.info.title).toContain(dateInWords(document.truth.periodEnd));
        expect(pdf.pages[0]?.text).toContain('Quarterly Report');
        expect(pdf.pages[0]?.text.startsWith(document.truth.sponsorFundName)).toBe(true);
        expect(pdf.pages[0]?.text).toContain(`reference ${document.truth.investmentNumber}`);
        expect(pdf.pages[1]?.text).toContain('Financial summary');
        expect(pdf.pages[2]?.text).toContain('Position summary');
        expect(pdf.pages[3]?.text).toContain('Notes');
        for (const bullet of document.truth.highlights)
          expect(pdf.pages[0]?.text.replace(/\n/g, ' ')).toContain(bullet);
      }
    }
  });
});

describe('determinism and hashing', () => {
  it('gives byte-identical documents and equal truths on a second run', () => {
    const again = generateDocuments(generateDataset({ profile: 'small', seed: 42 }));
    expect(again.expectations).toEqual(expectations);
    expect(again.documents.map((d) => d.fileName)).toEqual(documents.map((d) => d.fileName));
    again.documents.forEach((d, i) => {
      expect(
        Buffer.from(d.bytes).equals(Buffer.from(documents[i]?.bytes ?? new Uint8Array())),
      ).toBe(true);
      expect(d.truth).toEqual(documents[i]?.truth);
    });
    const other = generateDocuments(generateDataset({ profile: 'small', seed: 7 }));
    expect(other.documents[0]?.truth.contentHash).not.toBe(documents[0]?.truth.contentHash);
  });

  it('computes the SHA-256 the document store computes', () => {
    const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    for (const length of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(bytes), `length ${length}`).toBe(hex(bytes));
    }
    for (const document of documents) {
      expect(document.truth.contentHash).toBe(hex(document.bytes));
      expect(document.truth.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('serializes every truth as plain JSON', () => {
    for (const document of documents) {
      const text = JSON.stringify(document.truth);
      expect(JSON.parse(text)).toEqual(document.truth);
      expect(text).not.toContain(EM_DASH);
    }
  });
});

describe('options and helpers', () => {
  it('a smaller cap writes fewer reports and the window fewer notices; a bad cap is refused', () => {
    const fewer = generateDocuments(small, { quartersPerInvestment: 1, noticeMonths: 6 });
    expect(fewer.expectations.byDocType[SYNTHETIC_DOC_TYPES.quarterlyFinancials] ?? 0).toBeLessThan(
      expectations.byDocType[SYNTHETIC_DOC_TYPES.quarterlyFinancials] ?? 0,
    );
    const notices = (e: typeof expectations): number =>
      (e.byDocType[SYNTHETIC_DOC_TYPES.capitalCall] ?? 0) +
      (e.byDocType[SYNTHETIC_DOC_TYPES.distributionNotice] ?? 0);
    expect(notices(fewer.expectations)).toBeLessThan(notices(expectations));
    const fundLevel = (s: typeof set): number =>
      s.documents.filter(
        (d) =>
          d.truth.docType === SYNTHETIC_DOC_TYPES.capitalAccountStatement &&
          d.truth.investmentId === null,
      ).length;
    expect(fundLevel(fewer)).toBe(fundLevel(set));
    // With one quarter per investment no investment has two kept quarters, so no scenario fits,
    // and the positions the scenarios would have taken get statements of their own instead.
    expect(expectations.positionStatements).toHaveLength(6);
    expect(fewer.expectations.positionStatements).toHaveLength((3 + PLAIN_POSITION_STATEMENTS) * 2);
    expect(fewer.expectations.lateFinancials).toBeNull();
    expect(fewer.expectations.scenarioFiles.injection_doc).toEqual([]);
    expect(() => generateDocuments(small, { quartersPerInvestment: 0 })).toThrow(/at least 1/);
    expect(() => generateDocuments(small, { quartersPerInvestment: 1.5 })).toThrow(/whole number/);
    expect(() => generateDocuments(small, { noticeMonths: 0 })).toThrow(/at least 1/);
  });

  it('sanitizes file names and formats dates and millions', () => {
    expect(sanitizeFileName('Fund I: a/b\\c*d?e"f<g>h|i')).toBe('Fund I a b c d e f g h i');
    expect(sanitizeFileName('  two   spaces  ')).toBe('two spaces');
    expect(sanitizeFileName('trailing dots...')).toBe('trailing dots');
    // A long run of dots that does not end the name: kept, and cut in linear time.
    const dots = '.'.repeat(60_000);
    const started = performance.now();
    expect(sanitizeFileName(`a${dots}b...`)).toBe(`a${dots}b`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(sanitizeFileName('tab\tand\u0007bell')).toBe('tabandbell');
    expect(sanitizeFileName('Marram Fund III (A)')).toBe('Marram Fund III (A)');
    expect(documentFileName('2025-06-30', 'Marram Fund I', 'doc_type.capital_call', 'A/B Co')).toBe(
      '2025-06-30 Marram Fund I - Capital call - A B Co.pdf',
    );
    expect(
      documentFileName('2025-06-30', 'Marram Fund I', 'doc_type.capital_account_statement', null),
    ).toBe('2025-06-30 Marram Fund I - Capital account statement.pdf');
    expect(dateInWords('2025-06-30')).toBe('30 June 2025');
    expect(dateInWords('2024-01-05')).toBe('5 January 2024');
    expect(millions('12345678.90')).toBe('12.35');
    expect(millions('-250000.00')).toBe('-0.25');
    expect(millions('1000000')).toBe('1.00');
  });

  it('wraps text by measured width and keeps every word', () => {
    const text =
      'Net debt was unchanged at a level the sponsor considers comfortable for the balance of the year ahead.';
    const lines = wrapText(text, 'Helvetica', 10.5, 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    expect(wrapText('one', 'Helvetica', 10.5, 200)).toEqual(['one']);
    expect(wrapText('', 'Helvetica', 10.5, 200)).toEqual([]);
    expect(wrapText('averyverylongwordthatcannotbreak', 'Helvetica', 10.5, 20)).toEqual([
      'averyverylongwordthatcannotbreak',
    ]);
  });
});

describe('the written folder tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-synthetic-documents-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes the employer-data scan when written as the CLI writes it', () => {
    mkdirSync(join(root, 'inbox'), { recursive: true });
    mkdirSync(join(root, 'truth'), { recursive: true });
    for (const document of documents) {
      writeFileSync(join(root, 'inbox', document.fileName), document.bytes);
      writeFileSync(
        join(root, 'truth', `${document.truth.contentHash}.json`),
        `${JSON.stringify(document.truth, null, 2)}\n`,
      );
    }
    const script = resolve(import.meta.dirname, '../../../scripts/check-employer-data.sh');
    const result = spawnSync('bash', [script, '--paths', root], { encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('check-employer-data: OK');
  });
});
