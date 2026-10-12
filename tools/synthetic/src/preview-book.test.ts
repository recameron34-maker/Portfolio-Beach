import { describe, expect, it } from 'vitest';
import { accountingExports } from './accounting-export.js';
import { generateDataset } from './generate.js';
import { previewBook, previewSampleFileName } from './preview-book.js';

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
    expect(walled?.aliases).toEqual([]);
    expect(book.matchGuards).toEqual(
      dataset.matchGuards.map((g) => ({ nameA: g.nameA, nameB: g.nameB })),
    );
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

  it('holds no email, no user and no figure a page shows', () => {
    const text = JSON.stringify(book);
    expect(text).not.toContain('@');
    for (const user of dataset.users) expect(text).not.toContain(user.displayName);
  });
});
