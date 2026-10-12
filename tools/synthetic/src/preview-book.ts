import type { SyntheticDataset } from '@pb/db';
import { accountingExports } from './accounting-export.js';
import type { AccountingExportExpectations, ExportScenario } from './accounting-export.js';

/**
 * The book as the system actor sees it (decision 0009), taken straight from a generated dataset:
 * what the static preview links, diffs and checks an accounting export against in the browser,
 * the same inputs the API's intake service reads from the database. scripts/build-preview.mjs
 * writes it as preview/book.json and apps/web/src/preview/book.ts parses it. It carries the
 * record's figures for the diff and the rules only; every figure a page shows still comes from
 * the recorded responses.
 */

/** An investment with its company's names, as packages/validation links to it; aliases are not on record yet. */
export interface PreviewBookInvestment {
  id: string;
  investmentNumber: string;
  companyName: string;
  canonicalName: string;
  aliases: string[];
  dealType: string;
  entryDate: string;
  exitDate: string | null;
  isActive: boolean;
}

/** An approved quarter on record; `id` is the target a staged row would replace. */
export interface PreviewBookQuarter {
  id: string;
  periodEnd: string;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
  isEntrySnapshot: boolean;
}

export interface PreviewBookMark {
  periodEnd: string;
  fairValue: string;
}

/** A bundled sample export with what the generator says it carries, for the preview's exports list and its probe. */
export interface PreviewBookSample {
  scenario: ExportScenario;
  fileName: string;
  expectations: AccountingExportExpectations;
}

export interface PreviewBook {
  generatedFrom: string;
  asOf: string;
  investments: PreviewBookInvestment[];
  matchGuards: { nameA: string; nameB: string }[];
  /** Approved quarters per investment id, oldest first (period end, then id), as the API reads them. */
  quarters: Record<string, PreviewBookQuarter[]>;
  /** Locked marks per investment id, by period end with the highest version first, so find() keeps the latest version. */
  lockedMarks: Record<string, PreviewBookMark[]>;
  samples: PreviewBookSample[];
}

/** The fixed name the preview bundles a sample export under (the intake page requests it by this name). */
export function previewSampleFileName(scenario: ExportScenario): string {
  return `accounting-${scenario}.csv`;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function previewBook(dataset: SyntheticDataset): PreviewBook {
  const companies = new Map(dataset.portfolioCompanies.map((c) => [c.id, c]));
  const investments: PreviewBookInvestment[] = dataset.investments.map((inv) => {
    const company = companies.get(inv.portfolioCompanyId);
    return {
      id: inv.id,
      investmentNumber: inv.investmentNumber,
      companyName: company?.name ?? '',
      canonicalName: company?.canonicalName ?? '',
      aliases: [],
      dealType: inv.dealType,
      entryDate: inv.entryDate,
      exitDate: inv.exitDate,
      isActive: inv.isActive,
    };
  });

  const quarters: Record<string, PreviewBookQuarter[]> = {};
  const approved = dataset.quarterlyPerformance
    .filter((q) => q.status === 'record_status.approved')
    .sort((a, b) => byText(a.periodEnd, b.periodEnd) || byText(a.id, b.id));
  for (const q of approved) {
    (quarters[q.investmentId] ??= []).push({
      id: q.id,
      periodEnd: q.periodEnd,
      revenueLtm: q.revenueLtm,
      ebitdaLtm: q.ebitdaLtm,
      ev: q.ev,
      netDebt: q.netDebt,
      isEntrySnapshot: q.isEntrySnapshot,
    });
  }

  const lockedMarks: Record<string, PreviewBookMark[]> = {};
  const locked = dataset.valuations
    .filter((v) => v.state === 'Locked')
    .sort((a, b) => byText(a.periodEnd, b.periodEnd) || b.version - a.version);
  for (const v of locked) {
    (lockedMarks[v.investmentId] ??= []).push({ periodEnd: v.periodEnd, fairValue: v.fairValue });
  }

  const samples: PreviewBookSample[] = accountingExports(dataset).map((sample, i) => {
    const scenario = (['clean', 'update', 'defects'] as const)[i];
    if (scenario === undefined) throw new Error('accountingExports gave more than three samples');
    return {
      scenario,
      fileName: previewSampleFileName(scenario),
      expectations: sample.expectations,
    };
  });

  return {
    generatedFrom: `tools/synthetic ${dataset.profile} profile, seed ${dataset.seed}`,
    asOf: dataset.asOf,
    investments,
    matchGuards: dataset.matchGuards.map((g) => ({ nameA: g.nameA, nameB: g.nameB })),
    quarters,
    lockedMarks,
    samples,
  };
}
