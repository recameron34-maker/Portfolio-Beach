import { describe, expect, it } from 'vitest';
import { accountingExports } from './accounting-export.js';
import { aliasesOf } from './aliases.js';
import { generateDataset } from './generate.js';
import { investedCost, lookthroughExtract } from './lookthrough-extract.js';
import { opsDropWorkbooks } from './ops-drop.js';
import {
  previewBook,
  previewLookthroughExtracts,
  previewLookthroughFileName,
  previewOpsDropFileName,
  previewSampleFileName,
  previewWeeklyFileName,
} from './preview-book.js';
import { weeklyValuesSet } from './weekly-values.js';

describe('the preview book: the system actor view of a generated dataset', () => {
  const dataset = generateDataset({ profile: 'small', seed: 42 });
  const book = previewBook(dataset);

  it('lists every investment with its company names and the match guards', () => {
    expect(book.asOf).toBe(dataset.asOf);
    expect(book.investments).toHaveLength(dataset.investments.length);
    const walledId = dataset.scenarios.walled_deal?.[0];
    const walled = book.investments.find((i) => i.id === walledId);
    const company = dataset.portfolioCompanies.find(
      (c) => c.id === dataset.investments.find((i) => i.id === walledId)?.portfolioCompanyId,
    );
    expect(walled?.companyName).toBe(company?.name);
    expect(walled?.canonicalName).toBe(company?.canonicalName);
    expect(walled?.sector).toBe(company?.sector);
    expect(walled?.geography).toBe(company?.geography);
    expect(book.matchGuards).toEqual(
      dataset.matchGuards.map((g) => ({ nameA: g.nameA, nameB: g.nameB })),
    );
  });

  it('lists each company alias on its investment, as the API directory links by them', () => {
    expect(dataset.companyAliases.length).toBeGreaterThan(0);
    for (const inv of book.investments) {
      const source = dataset.investments.find((i) => i.id === inv.id);
      expect(inv.aliases).toEqual(aliasesOf(dataset, source?.portfolioCompanyId ?? ''));
    }
    expect(book.investments.some((i) => i.aliases.length > 0)).toBe(true);
    // Every company carries its taxonomy codes for the reconcile to compare with.
    expect(book.investments.every((i) => i.sector !== null && i.geography !== null)).toBe(true);
  });

  it('carries the invested cost per investment on each bundled extract date, as the API computes it', () => {
    const extracts = previewLookthroughExtracts(dataset);
    expect(Object.keys(book.investedCost).sort()).toEqual(extracts.map((e) => e.asOf).sort());
    for (const extract of extracts) {
      const byInvestment = book.investedCost[extract.asOf] ?? {};
      expect(Object.keys(byInvestment)).toHaveLength(dataset.investments.length);
      for (const inv of dataset.investments)
        expect(byInvestment[inv.id]).toBe(investedCost(dataset, inv.id, extract.asOf));
      // The extract's own cost column is the same number, so a clean row ties.
      for (const row of extract.rows) {
        const inv = dataset.investments.find((i) => i.investmentNumber === row.investmentNumber);
        if (inv === undefined || extract.expectations.differences.length > 0) continue;
        expect(row.exposureAtCost).toBe(byInvestment[inv.id]);
      }
    }
  });

  it('carries approved quarters only, oldest first, with the id a staged row would replace', () => {
    const approved = dataset.quarterlyPerformance.filter(
      (q) => q.status === 'record_status.approved',
    );
    const listed = Object.values(book.quarters).flat();
    expect(listed).toHaveLength(approved.length);
    expect(new Set(listed.map((q) => q.id))).toEqual(new Set(approved.map((q) => q.id)));
    for (const [investmentId, quarters] of Object.entries(book.quarters)) {
      for (let i = 1; i < quarters.length; i++)
        expect(quarters[i - 1]!.periodEnd <= quarters[i]!.periodEnd, investmentId).toBe(true);
    }
    const pending = dataset.quarterlyPerformance.find((q) => q.status !== 'record_status.approved');
    if (pending !== undefined) expect(listed.some((q) => q.id === pending.id)).toBe(false);
  });

  it('carries Locked marks only, the highest version first within a period end', () => {
    const locked = dataset.valuations.filter((v) => v.state === 'Locked');
    const listed = Object.values(book.lockedMarks).flat();
    expect(listed).toHaveLength(locked.length);
    // The state travels with each mark, as the preview's book schema requires and lockedNear reads it.
    expect(listed.every((m) => m.state === 'Locked')).toBe(true);
    for (const [investmentId, marks] of Object.entries(book.lockedMarks)) {
      const own = locked.filter((v) => v.investmentId === investmentId);
      for (const mark of marks) {
        const versions = own
          .filter((v) => v.periodEnd === mark.periodEnd)
          .sort((a, b) => b.version - a.version);
        // The first mark listed for a period end is the latest version's.
        const first = marks.find((m) => m.periodEnd === mark.periodEnd);
        expect(first?.fairValue).toBe(versions[0]?.fairValue);
      }
    }
    const unlocked = dataset.valuations.find((v) => v.state !== 'Locked');
    expect(unlocked).toBeDefined();
  });

  it('names the three samples with their fixed file names and the generator expectations', () => {
    const exports = accountingExports(dataset);
    expect(book.samples.map((s) => s.scenario)).toEqual(['clean', 'update', 'defects']);
    expect(book.samples.map((s) => s.fileName)).toEqual([
      'accounting-clean.csv',
      'accounting-update.csv',
      'accounting-defects.csv',
    ]);
    expect(previewSampleFileName('defects')).toBe('accounting-defects.csv');
    expect(book.samples.map((s) => s.expectations)).toEqual(exports.map((e) => e.expectations));
  });

  it('names the weekly, look-through and ops drop samples the preview bundles', () => {
    const weekly = weeklyValuesSet(dataset);
    expect(book.weeklySamples.map((s) => s.scenario)).toEqual(['clean', 'update', 'defects']);
    expect(book.weeklySamples.map((s) => s.fileName)).toEqual([
      'weekly-values-clean.csv',
      'weekly-values-update.csv',
      'weekly-values-defects.csv',
    ]);
    expect(previewWeeklyFileName('defects')).toBe('weekly-values-defects.csv');
    expect(book.weeklySamples.map((s) => s.reportDate)).toEqual(weekly.map((w) => w.reportDate));
    expect(book.weeklySamples.map((s) => s.expectations)).toEqual(
      weekly.map((w) => w.expectations),
    );

    // The defects extract for the as-of date and the clean one for the quarter end before it, so
    // a reconcile of either date reads one of them.
    const extracts = previewLookthroughExtracts(dataset);
    expect(book.lookthroughSamples.map((s) => s.scenario)).toEqual(['clean', 'defects']);
    expect(book.lookthroughSamples.map((s) => s.asOf)).toEqual(['2025-03-31', '2025-06-30']);
    expect(book.lookthroughSamples.map((s) => s.fileName)).toEqual([
      'lookthrough-2025-03-31.json',
      'lookthrough-2025-06-30-defects.json',
    ]);
    expect(previewLookthroughFileName('2025-06-30', 'defects')).toBe(
      'lookthrough-2025-06-30-defects.json',
    );
    expect(extracts.map((e) => e.fileName)).toEqual(book.lookthroughSamples.map((s) => s.fileName));
    expect(book.lookthroughSamples.map((s) => s.expectations)).toEqual(
      extracts.map((e) => e.expectations),
    );
    expect(extracts[0]?.expectations.differences).toEqual([]);
    expect(extracts[1]?.expectations.differences.length).toBeGreaterThan(0);
    expect(extracts[0]).toEqual(lookthroughExtract(dataset, { asOf: '2025-03-31' }));

    const workbooks = opsDropWorkbooks(dataset);
    expect(book.opsDropSamples.map((s) => s.scenario)).toEqual([
      'clean',
      'update',
      'defects',
      'unknown-template',
    ]);
    expect(book.opsDropSamples.map((s) => s.fileName)).toEqual([
      'ops-drop-clean.xlsx',
      'ops-drop-update.xlsx',
      'ops-drop-defects.xlsx',
      'ops-drop-unknown-template.xlsx',
    ]);
    expect(previewOpsDropFileName('unknown-template')).toBe('ops-drop-unknown-template.xlsx');
    expect(book.opsDropSamples.map((s) => s.template)).toEqual(workbooks.map((w) => w.template));
    expect(book.opsDropSamples.map((s) => s.expectations)).toEqual(
      workbooks.map((w) => w.expectations),
    );
  });

  it('holds no email address and no user display name', () => {
    const text = JSON.stringify(book);
    expect(text).not.toContain('@');
    for (const user of dataset.users) expect(text).not.toContain(user.displayName);
  });
});
