import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, addMonths } from '@pb/calc';
import { readPdf } from '@pb/pdf';
import type { PdfDocument } from '@pb/pdf';
import { nodeInflate } from '@pb/pdf/node';
import style from '../../../config/style.json' with { type: 'json' };
import {
  DOCUMENT_DEFAULTS,
  DOCUMENT_SET_SCENARIOS,
  DOC_TYPE_LABELS,
  INJECTION_TEXT,
  QUARTERLY_FIELDS,
  RESTATEMENT_DRIFT,
  SYNTHETIC_DOC_TYPES,
  UNTAGGED_FILE_NAME,
  dateInWords,
  documentFileName,
  generateDocuments,
  millions,
  sanitizeFileName,
  sha256Hex,
  wrapText,
} from './documents.js';
import type { SyntheticDocument } from './documents.js';
import { generateDataset } from './generate.js';
import { walledInvestment } from './marks.js';

const EM_DASH = String.fromCharCode(0x2014);
const small = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(small);
const { documents, expectations } = set;
const reports = documents.filter(
  (d) => d.truth.docType === SYNTHETIC_DOC_TYPES.quarterlyFinancials,
);
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
    expect(expectations.total).toBeLessThanOrEqual(80);
    const summed = Object.values(expectations.byDocType).reduce((a, b) => a + b, 0);
    expect(summed).toBe(expectations.total);
    for (const [code, count] of Object.entries(expectations.byDocType))
      expect(documents.filter((d) => d.truth.docType === code)).toHaveLength(count);
    expect(Object.keys(expectations.byDocType).sort()).toEqual(
      Object.values(SYNTHETIC_DOC_TYPES).sort(),
    );
    expect(expectations.byDocType[SYNTHETIC_DOC_TYPES.capitalAccountStatement]).toBe(
      new Set(small.commitments.map((c) => c.sponsorFundId)).size,
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

  it('writes one capital account statement per sponsor fund with a commitment, from the cash flows', () => {
    const statements = documents.filter(
      (d) => d.truth.docType === SYNTHETIC_DOC_TYPES.capitalAccountStatement,
    );
    const fundIds = new Set(small.commitments.map((c) => c.sponsorFundId));
    expect(new Set(statements.map((d) => d.truth.sponsorFundId))).toEqual(fundIds);
    for (const statement of statements) {
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
    expect(fewer.expectations.byDocType[SYNTHETIC_DOC_TYPES.capitalAccountStatement]).toBe(
      expectations.byDocType[SYNTHETIC_DOC_TYPES.capitalAccountStatement],
    );
    // With one quarter per investment no investment has two kept quarters, so no scenario fits.
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
