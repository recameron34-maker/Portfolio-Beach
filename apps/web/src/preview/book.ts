import { z } from 'zod';
import { SAMPLE_SCENARIOS, sampleFileName } from '../pages/intake/intake.js';

/**
 * preview/book.json, written by scripts/build-preview.mjs from `previewBook(dataset)` in
 * tools/synthetic: the book as the system actor sees it (decision 0009), which the simulated
 * intake links, diffs and checks an export against. It carries the record's figures for the diff
 * and the rules only; every figure a page shows still comes from the recordings.
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

const bookMark = z.object({ periodEnd: isoDate, fairValue: decimal });

/** A bundled sample with what the generator says it carries (tools/synthetic accountingExport). */
const bookSample = z
  .object({
    scenario: z.enum(SAMPLE_SCENARIOS),
    fileName: z.string().min(1),
    expectations: z.object({
      rows: z.number().int(),
      changed: z.array(z.string()),
      added: z.array(z.string()),
      flagged: z.array(z.object({ rowNo: z.number().int(), ruleId: z.string() })),
    }),
  })
  .refine((s) => s.fileName === sampleFileName(s.scenario), {
    message: 'a sample must be bundled under the name the intake page requests',
    path: ['fileName'],
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
  samples: z.array(bookSample),
});

export type PreviewBook = z.infer<typeof previewBook>;
export type BookInvestment = z.infer<typeof bookInvestment>;
export type BookQuarter = z.infer<typeof bookQuarter>;
export type BookSample = z.infer<typeof bookSample>;

const REBUILD = 'rebuild it with pnpm --filter @pb/web build:preview';

/** Validates a loaded book file; the error names the first problem and how to fix it. */
export function parseBook(raw: unknown): PreviewBook {
  const parsed = previewBook.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.') || '(root)'}`;
  throw new Error(`the preview book is not in the expected format${where}; ${REBUILD}`);
}
