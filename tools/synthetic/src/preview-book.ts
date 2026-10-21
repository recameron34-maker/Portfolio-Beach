import { addMonths, containingQuarterEnd } from '@pb/calc';
import { accountingExports } from './accounting-export.js';
import type { AccountingExportExpectations, ExportScenario } from './accounting-export.js';
import { aliasesOf } from './aliases.js';
import type { AliasedDataset } from './aliases.js';
import { generateDocuments } from './documents.js';
import type { DocumentSet, DocumentSetExpectations, Truth } from './documents.js';
import { investedCost, lookthroughExtract } from './lookthrough-extract.js';
import type {
  LookthroughExpectations,
  LookthroughExtract,
  LookthroughScenario,
} from './lookthrough-extract.js';
import { opsDropWorkbooks } from './ops-drop.js';
import type { OpsDropExpectations, OpsDropScenario, OpsDropWorkbook } from './ops-drop.js';
import { weeklyValuesSet } from './weekly-values.js';
import type { WeeklyScenario, WeeklyValues, WeeklyValuesExpectations } from './weekly-values.js';

/**
 * The book as the system actor sees it (decision 0009), taken straight from a generated dataset:
 * what the static preview links, diffs and checks an accounting export, a weekly values file, a
 * look-through extract or an operations workbook against in the browser, the same inputs the
 * API's intake services read from the database. scripts/build-preview.mjs writes it as
 * preview/book.json and apps/web/src/preview/book.ts parses it. It carries the record's figures
 * for the diff and the rules only; every figure a page shows still comes from the recorded
 * responses.
 */

/** An investment with its company's names and taxonomy codes, as packages/validation links to it and the reconcile compares it. */
export interface PreviewBookInvestment {
  id: string;
  investmentNumber: string;
  companyName: string;
  canonicalName: string;
  /** The company's aliases (core.company_alias), as the API's investment directory lists them. */
  aliases: string[];
  dealType: string;
  entryDate: string;
  exitDate: string | null;
  isActive: boolean;
  /** The company's taxonomy codes, which a look-through reconcile compares the provider's labels with. */
  sector: string | null;
  geography: string | null;
  /** The position's parents (core.investment), which a classified document inherits and the monitoring board names. */
  sponsorId: string;
  sponsorFundId: string | null;
  vehicleId: string;
  vehicleName: string;
}

/** A sponsor fund with its names and aliases (core.fund_alias), which the document linker matches a file name's fund against. */
export interface PreviewBookSponsorFund {
  id: string;
  sponsorId: string;
  name: string;
  canonicalName: string;
  aliases: string[];
}

/**
 * What the expected-document generation needs beside the investments: the deal types whose
 * sponsors report quarterly figures (one quarterly_financials row each per quarter) and the
 * sponsor funds the firm has a commitment to, with the earliest commitment date (one
 * capital_account_statement row each for a quarter ending on or after it).
 */
export interface PreviewBookExpectedDocumentDefaults {
  reportingDealTypes: string[];
  fundCommitments: { sponsorFundId: string; commitmentDate: string }[];
}

/**
 * One bundled document of the synthetic set (preview/samples/documents/<fileName>): its store
 * metadata and its truth sidecar, the recorded fixture the simulated extraction answers for its
 * content hash. The duplicate pair is two entries sharing one hash and one truth.
 */
export interface PreviewBookDocument {
  fileName: string;
  folder: 'inbox';
  contentHash: string;
  sizeBytes: number;
  pageCount: number;
  truth: Truth;
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

/** A Locked mark; the state travels so lockedNear in @pb/calc reads it the way the API's marks are read. */
export interface PreviewBookMark {
  state: 'Locked';
  periodEnd: string;
  fairValue: string;
}

/** A bundled sample export with what the generator says it carries, for the preview's exports list and its probe. */
export interface PreviewBookSample {
  scenario: ExportScenario;
  fileName: string;
  expectations: AccountingExportExpectations;
}

/** A bundled weekly values file (the preview's weekly drop folder) with what the generator says it carries. */
export interface PreviewBookWeeklySample {
  scenario: WeeklyScenario;
  fileName: string;
  reportDate: string;
  expectations: WeeklyValuesExpectations;
}

/** A bundled look-through extract (the preview's look-through folder), served for a reconcile of its as-of date. */
export interface PreviewBookLookthroughSample {
  scenario: LookthroughScenario;
  fileName: string;
  asOf: string;
  expectations: LookthroughExpectations;
}

/** A bundled operations workbook (the preview's ops drop folder) with the template it was written for. */
export interface PreviewBookOpsDropSample {
  scenario: OpsDropScenario;
  fileName: string;
  template: string | null;
  periodEnd: string;
  expectations: OpsDropExpectations;
}

export interface PreviewBook {
  generatedFrom: string;
  asOf: string;
  investments: PreviewBookInvestment[];
  sponsorFunds: PreviewBookSponsorFund[];
  expectedDocumentDefaults: PreviewBookExpectedDocumentDefaults;
  matchGuards: { nameA: string; nameB: string }[];
  /** Approved quarters per investment id, oldest first (period end, then id), as the API reads them. */
  quarters: Record<string, PreviewBookQuarter[]>;
  /** Locked marks per investment id, by period end with the highest version first, so lockedNear keeps the latest version. */
  lockedMarks: Record<string, PreviewBookMark[]>;
  /**
   * The invested cost per investment id on each date a bundled look-through extract reconciles
   * for, as the API computes `invested` (the approved contributions on or before the date through
   * summarizeFlows in @pb/calc; null when nothing was contributed). The reconcile compares the
   * provider's exposure at cost with it (CLAUDE.md rule 7: one derivation, never a second).
   */
  investedCost: Record<string, Record<string, string | null>>;
  samples: PreviewBookSample[];
  weeklySamples: PreviewBookWeeklySample[];
  lookthroughSamples: PreviewBookLookthroughSample[];
  opsDropSamples: PreviewBookOpsDropSample[];
  /** The synthetic document set the preview bundles, in generation order, with what the generator says it carries. */
  documents: PreviewBookDocument[];
  documentExpectations: DocumentSetExpectations;
}

/**
 * The deal types whose sponsors report quarterly figures, so the tracker expects a quarterly
 * report per quarter (apps/api/src/documents/expected.ts QUARTERLY_REPORTING_DEAL_TYPES, a
 * constant until the owner names its config key). Carried in the book so the preview reads it
 * from data rather than repeating it in browser code.
 */
export const QUARTERLY_REPORTING_DEAL_TYPES: readonly string[] = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
];

/** Where the preview bundles a document of the set, relative to the page: the store's file name, URL-encoded. */
export function previewDocumentPath(fileName: string): string {
  return `preview/samples/documents/${encodeURIComponent(fileName)}`;
}

export interface PreviewBookOptions {
  /** The document set already generated for the same dataset, so the build writes it once. */
  documents?: DocumentSet;
}

/** The fixed name the preview bundles a sample export under (the intake page requests it by this name). */
export function previewSampleFileName(scenario: ExportScenario): string {
  return `accounting-${scenario}.csv`;
}

/** The fixed name the preview bundles a weekly values file under (its drop folder lists it by this name). */
export function previewWeeklyFileName(scenario: WeeklyScenario): string {
  return `weekly-values-${scenario}.csv`;
}

/** The fixed name the preview bundles an operations workbook under (its ops drop folder lists it by this name). */
export function previewOpsDropFileName(scenario: OpsDropScenario): string {
  return `ops-drop-${scenario}.xlsx`;
}

/** The name the preview bundles a look-through extract under: the generator's own, `lookthrough-<asOf>[-<scenario>].json`. */
export function previewLookthroughFileName(asOf: string, scenario: LookthroughScenario): string {
  return `lookthrough-${asOf}${scenario === 'clean' ? '' : `-${scenario}`}.json`;
}

/**
 * The extracts the preview's look-through folder holds, one per as-of date, so each is reachable
 * through a reconcile of its date: the defects extract for the dataset's as-of date (a reconcile
 * of the current quarter has differences and exceptions to work), and the clean extract for the
 * quarter end before it (a reconcile of the last quarter agrees with the record).
 */
export function previewLookthroughExtracts(dataset: AliasedDataset): LookthroughExtract[] {
  const priorQuarterEnd = containingQuarterEnd(addMonths(dataset.asOf, -3));
  return [
    lookthroughExtract(dataset, { scenario: 'clean', asOf: priorQuarterEnd }),
    lookthroughExtract(dataset, { scenario: 'defects', asOf: dataset.asOf }),
  ];
}

/** The weekly values files the preview's weekly drop folder holds, in scenario order. */
export function previewWeeklyFiles(dataset: AliasedDataset): WeeklyValues[] {
  return weeklyValuesSet(dataset);
}

/** The workbooks the preview's ops drop folder holds, in scenario order. */
export function previewOpsDropWorkbooks(dataset: AliasedDataset): OpsDropWorkbook[] {
  return opsDropWorkbooks(dataset);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function previewBook(
  dataset: AliasedDataset,
  options: PreviewBookOptions = {},
): PreviewBook {
  const companies = new Map(dataset.portfolioCompanies.map((c) => [c.id, c]));
  const vehicleName = new Map(dataset.vehicles.map((v) => [v.id, v.name]));
  const investments: PreviewBookInvestment[] = dataset.investments.map((inv) => {
    const company = companies.get(inv.portfolioCompanyId);
    return {
      id: inv.id,
      investmentNumber: inv.investmentNumber,
      companyName: company?.name ?? '',
      canonicalName: company?.canonicalName ?? '',
      aliases: aliasesOf(dataset, inv.portfolioCompanyId),
      dealType: inv.dealType,
      entryDate: inv.entryDate,
      exitDate: inv.exitDate,
      isActive: inv.isActive,
      sector: company?.sector ?? null,
      geography: company?.geography ?? null,
      sponsorId: inv.sponsorId,
      sponsorFundId: inv.sponsorFundId,
      vehicleId: inv.vehicleId,
      vehicleName: vehicleName.get(inv.vehicleId) ?? '',
    };
  });

  const fundAliases = new Map<string, string[]>();
  for (const a of dataset.fundAliases)
    fundAliases.set(a.sponsorFundId, [...(fundAliases.get(a.sponsorFundId) ?? []), a.alias]);
  const sponsorFunds: PreviewBookSponsorFund[] = dataset.sponsorFunds.map((f) => ({
    id: f.id,
    sponsorId: f.sponsorId,
    name: f.name,
    canonicalName: f.canonicalName,
    aliases: fundAliases.get(f.id) ?? [],
  }));

  // The earliest commitment per sponsor fund: a statement is expected for a quarter ending on
  // or after it (apps/api/src/documents/expected.service.ts generate).
  const earliest = new Map<string, string>();
  for (const c of dataset.commitments) {
    const known = earliest.get(c.sponsorFundId);
    if (known === undefined || c.commitmentDate < known)
      earliest.set(c.sponsorFundId, c.commitmentDate);
  }
  const expectedDocumentDefaults: PreviewBookExpectedDocumentDefaults = {
    reportingDealTypes: [...QUARTERLY_REPORTING_DEAL_TYPES],
    fundCommitments: [...earliest]
      .map(([sponsorFundId, commitmentDate]) => ({ sponsorFundId, commitmentDate }))
      .sort((a, b) => byText(a.sponsorFundId, b.sponsorFundId)),
  };

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
    (lockedMarks[v.investmentId] ??= []).push({
      state: 'Locked',
      periodEnd: v.periodEnd,
      fairValue: v.fairValue,
    });
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

  const weeklySamples: PreviewBookWeeklySample[] = previewWeeklyFiles(dataset).map((file, i) => {
    const scenario = (['clean', 'update', 'defects'] as const)[i];
    if (scenario === undefined) throw new Error('weeklyValuesSet gave more than three files');
    return {
      scenario,
      fileName: previewWeeklyFileName(scenario),
      reportDate: file.reportDate,
      expectations: file.expectations,
    };
  });

  const extracts = previewLookthroughExtracts(dataset);
  const lookthroughSamples: PreviewBookLookthroughSample[] = extracts.map((extract, i) => {
    const scenario = (['clean', 'defects'] as const)[i];
    if (scenario === undefined) throw new Error('previewLookthroughExtracts gave more than two');
    return {
      scenario,
      fileName: previewLookthroughFileName(extract.asOf, scenario),
      asOf: extract.asOf,
      expectations: extract.expectations,
    };
  });
  const investedCostByDate: Record<string, Record<string, string | null>> = {};
  for (const extract of extracts) {
    const byInvestment: Record<string, string | null> = {};
    for (const inv of dataset.investments)
      byInvestment[inv.id] = investedCost(dataset, inv.id, extract.asOf);
    investedCostByDate[extract.asOf] = byInvestment;
  }

  const opsDropSamples: PreviewBookOpsDropSample[] = previewOpsDropWorkbooks(dataset).map(
    (workbook) => ({
      scenario: workbook.scenario,
      fileName: previewOpsDropFileName(workbook.scenario),
      template: workbook.template,
      periodEnd: workbook.periodEnd,
      expectations: workbook.expectations,
    }),
  );

  const set = options.documents ?? generateDocuments(dataset);
  const documents: PreviewBookDocument[] = set.documents.map((doc) => ({
    fileName: doc.fileName,
    folder: doc.folder,
    contentHash: doc.truth.contentHash,
    sizeBytes: doc.bytes.length,
    pageCount: doc.truth.pageCount,
    truth: doc.truth,
  }));

  return {
    generatedFrom: `tools/synthetic ${dataset.profile} profile, seed ${dataset.seed}`,
    asOf: dataset.asOf,
    investments,
    sponsorFunds,
    expectedDocumentDefaults,
    matchGuards: dataset.matchGuards.map((g) => ({ nameA: g.nameA, nameB: g.nameB })),
    quarters,
    lockedMarks,
    investedCost: investedCostByDate,
    samples,
    weeklySamples,
    lookthroughSamples,
    opsDropSamples,
    documents,
    documentExpectations: set.expectations,
  };
}
