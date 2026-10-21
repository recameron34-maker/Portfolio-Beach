import { z } from 'zod';
import { SAMPLE_SCENARIOS, sampleFileName } from '../pages/intake/intake.js';

/**
 * preview/book.json, written by scripts/build-preview.mjs from `previewBook(dataset)` in
 * tools/synthetic: the book as the system actor sees it (decision 0009), which the simulated
 * intakes link, diff and check a file against: the accounting export and the operations workbook
 * (quarters and Locked marks), the weekly values (Locked marks as the prior) and the look-through
 * extract (taxonomy codes, Locked marks and the invested cost). It carries the record's figures for
 * the diff and the rules only; every figure a page shows still comes from the recordings.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const money = decimal.nullable();

const bookInvestment = z.object({
  id: z.string().min(1),
  investmentNumber: z.string().min(1),
  companyName: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  dealType: z.string(),
  entryDate: isoDate,
  exitDate: isoDate.nullable(),
  isActive: z.boolean(),
  /** The company's taxonomy codes, which a look-through reconcile compares the provider's labels with. */
  sector: z.string().nullable(),
  geography: z.string().nullable(),
  /** The position's parents (core.investment), which a classified document inherits and the monitoring board names. */
  sponsorId: z.string().min(1),
  sponsorFundId: z.string().nullable(),
  vehicleId: z.string().min(1),
  vehicleName: z.string(),
});

/** A sponsor fund with its names and aliases (core.fund_alias), which the document linker matches a file name's fund against. */
const bookSponsorFund = z.object({
  id: z.string().min(1),
  sponsorId: z.string().min(1),
  name: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()),
});

/** What the expected-document generation reads beside the investments (apps/api/src/documents/expected.service.ts). */
const bookExpectedDocumentDefaults = z.object({
  /** The deal types whose sponsors report quarterly figures (QUARTERLY_REPORTING_DEAL_TYPES). */
  reportingDealTypes: z.array(z.string()),
  /** The sponsor funds the firm has a commitment to, each with its earliest commitment date. */
  fundCommitments: z.array(z.object({ sponsorFundId: z.string().min(1), commitmentDate: isoDate })),
});

const unit = z.enum(['USD', 'USD_K', 'USD_M', 'USD_B', 'PCT', 'COUNT', 'DATE']);

/** One truth field as the sidecar records it (packages/ai parseTruth reads the same keys). */
const bookTruthField = z.object({
  value: z.string().nullable(),
  unit: unit.nullable(),
  page: z.number().int().nullable(),
  quote: z.string().nullable(),
});

/**
 * A document's truth sidecar: the recorded fixture output the simulated extraction answers for
 * the document's content hash (fields, highlights, commentary) and what the generator says about
 * the document (its type, links, period and scenarios), which the tests and the probe read.
 */
const bookTruth = z.object({
  fileName: z.string(),
  fileNames: z.array(z.string()),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  docType: z.string(),
  sponsorId: z.string(),
  sponsorFundId: z.string(),
  sponsorFundName: z.string(),
  investmentId: z.string().nullable(),
  investmentNumber: z.string().nullable(),
  companyName: z.string().nullable(),
  periodEnd: isoDate,
  pageCount: z.number().int(),
  fields: z.record(z.string(), bookTruthField),
  highlights: z.array(z.string()),
  commentary: z.string().nullable(),
  scenarios: z.array(z.string()),
  expectedClassification: z.object({ docType: z.string(), confidenceAtLeast: decimal }),
});

/** One bundled document of the synthetic set (preview/samples/documents/<fileName>) with its truth. */
const bookDocument = z.object({
  fileName: z.string().min(1),
  folder: z.literal('inbox'),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int(),
  pageCount: z.number().int(),
  truth: bookTruth,
});

/** What the generator says the document set carries (tools/synthetic DocumentSetExpectations). */
const bookDocumentExpectations = z.object({
  byDocType: z.record(z.string(), z.number().int()),
  scenarioFiles: z.record(z.string(), z.array(z.string())),
  walledFiles: z.array(z.string()),
  total: z.number().int(),
  lateFinancials: z
    .object({
      investmentId: z.string(),
      investmentNumber: z.string(),
      companyName: z.string(),
      periodEnd: isoDate,
      fileName: z.string(),
    })
    .nullable(),
});

/** An approved quarter on record; `id` is the target a staged row would replace. */
const bookQuarter = z.object({
  id: z.string().min(1),
  periodEnd: isoDate,
  revenueLtm: money,
  ebitdaLtm: money,
  ev: money,
  netDebt: money,
  isEntrySnapshot: z.boolean(),
});

/** Only Locked marks are in the book; the state travels so @pb/calc's lockedNear reads them. */
const bookMark = z.object({ state: z.literal('Locked'), periodEnd: isoDate, fairValue: decimal });

const flaggedRows = z.array(z.object({ rowNo: z.number().int(), ruleId: z.string() }));

/** What the generator says an accounting-shaped sample carries (tools/synthetic accountingExport). */
const accountingExpectations = z.object({
  rows: z.number().int(),
  changed: z.array(z.string()),
  added: z.array(z.string()),
  flagged: flaggedRows,
  walled: z.array(z.number().int()).optional(),
});

/** A bundled sample with what the generator says it carries (tools/synthetic accountingExport). */
const bookSample = z
  .object({
    scenario: z.enum(SAMPLE_SCENARIOS),
    fileName: z.string().min(1),
    expectations: accountingExpectations,
  })
  .refine((s) => s.fileName === sampleFileName(s.scenario), {
    message: 'a sample must be bundled under the name the intake page requests',
    path: ['fileName'],
  });

/** A bundled weekly values file (the simulated weekly drop folder) with what the generator says it carries. */
const bookWeeklySample = z.object({
  scenario: z.enum(SAMPLE_SCENARIOS),
  fileName: z.string().min(1),
  reportDate: isoDate,
  expectations: z.object({
    rows: z.number().int(),
    flagged: flaggedRows,
    moved: z.array(z.object({ investmentNumber: z.string(), pct: z.string() })),
    aliased: z.array(z.number().int()),
    walled: z.array(z.number().int()),
  }),
});

/** A bundled look-through extract (the simulated look-through folder), served for a reconcile of its as-of date. */
const bookLookthroughSample = z.object({
  scenario: z.enum(SAMPLE_SCENARIOS),
  fileName: z.string().min(1),
  asOf: isoDate,
  expectations: z.object({
    rows: z.number().int(),
    differences: z.array(z.object({ rowNo: z.number().int(), field: z.string() })),
    moved: z.array(z.object({ rowNo: z.number().int(), field: z.string(), pct: z.string() })),
    unmatched: z.array(z.number().int()),
    unmapped: z.array(z.number().int()),
    duplicates: z.array(z.number().int()),
    aliased: z.array(z.number().int()),
    walled: z.array(z.number().int()),
  }),
});

/** A bundled operations workbook (the simulated ops drop folder) with the template it was written for. */
const bookOpsDropSample = z.object({
  scenario: z.enum([...SAMPLE_SCENARIOS, 'unknown-template']),
  fileName: z.string().min(1),
  template: z.string().nullable(),
  periodEnd: isoDate,
  expectations: accountingExpectations.extend({ refused: z.boolean() }),
});

export const previewBook = z.object({
  generatedFrom: z.string(),
  asOf: isoDate,
  investments: z.array(bookInvestment),
  sponsorFunds: z.array(bookSponsorFund),
  expectedDocumentDefaults: bookExpectedDocumentDefaults,
  matchGuards: z.array(z.object({ nameA: z.string(), nameB: z.string() })),
  /** Approved quarters per investment id, oldest first, as the API reads them. */
  quarters: z.record(z.string(), z.array(bookQuarter)),
  /** Locked marks per investment id, the highest version first within a period end. */
  lockedMarks: z.record(z.string(), z.array(bookMark)),
  /**
   * The invested cost per investment id on each date a bundled look-through extract reconciles
   * for, as the API computes `invested` (summarizeFlows over the approved contributions); null
   * when nothing was contributed.
   */
  investedCost: z.record(isoDate, z.record(z.string(), money)),
  samples: z.array(bookSample),
  weeklySamples: z.array(bookWeeklySample),
  lookthroughSamples: z.array(bookLookthroughSample),
  opsDropSamples: z.array(bookOpsDropSample),
  /** The synthetic document set the preview bundles, in the generator's order (the store's inbox). */
  documents: z.array(bookDocument),
  documentExpectations: bookDocumentExpectations,
});

export type PreviewBook = z.infer<typeof previewBook>;
export type BookInvestment = z.infer<typeof bookInvestment>;
export type BookSponsorFund = z.infer<typeof bookSponsorFund>;
export type BookDocument = z.infer<typeof bookDocument>;
export type BookTruth = z.infer<typeof bookTruth>;
export type BookQuarter = z.infer<typeof bookQuarter>;
export type BookMark = z.infer<typeof bookMark>;
export type BookSample = z.infer<typeof bookSample>;
export type BookWeeklySample = z.infer<typeof bookWeeklySample>;
export type BookLookthroughSample = z.infer<typeof bookLookthroughSample>;
export type BookOpsDropSample = z.infer<typeof bookOpsDropSample>;

const REBUILD = 'rebuild it with pnpm --filter @pb/web build:preview';

/** Where the preview bundles a document of the set, relative to the page: the store's file name, URL-encoded (tools/synthetic previewDocumentPath). */
export function documentSamplePath(fileName: string): string {
  return `preview/samples/documents/${encodeURIComponent(fileName)}`;
}

/** Validates a loaded book file; the error names the first problem and how to fix it. */
export function parseBook(raw: unknown): PreviewBook {
  const parsed = previewBook.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.') || '(root)'}`;
  throw new Error(`the preview book is not in the expected format${where}; ${REBUILD}`);
}
