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
});

export type PreviewBook = z.infer<typeof previewBook>;
export type BookInvestment = z.infer<typeof bookInvestment>;
export type BookQuarter = z.infer<typeof bookQuarter>;
export type BookMark = z.infer<typeof bookMark>;
export type BookSample = z.infer<typeof bookSample>;
export type BookWeeklySample = z.infer<typeof bookWeeklySample>;
export type BookLookthroughSample = z.infer<typeof bookLookthroughSample>;
export type BookOpsDropSample = z.infer<typeof bookOpsDropSample>;

const REBUILD = 'rebuild it with pnpm --filter @pb/web build:preview';

/** Validates a loaded book file; the error names the first problem and how to fix it. */
export function parseBook(raw: unknown): PreviewBook {
  const parsed = previewBook.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.') || '(root)'}`;
  throw new Error(`the preview book is not in the expected format${where}; ${REBUILD}`);
}
