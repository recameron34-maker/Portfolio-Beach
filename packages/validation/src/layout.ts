import { z } from 'zod';
import { parseCsv } from './csv.js';
import { finding } from './types.js';
import type { Finding } from './types.js';

/**
 * config/accounting_layout.json: the generic accounting export's columns, each mapped to the field
 * it carries (docs/04 M2 accounting-import). The layout is config, never code (CLAUDE.md rule 9):
 * the real system's layout replaces the sample after merge without a code change.
 */
export const accountingLayout = z.object({
  _note: z.string().optional(),
  export: z.object({
    format: z.literal('csv'),
    dateFormat: z.literal('YYYY-MM-DD'),
    columns: z
      .array(
        z.object({
          name: z.string().min(1),
          source: z.string().min(1),
          unit: z.string().optional(),
          requires: z.string().optional(),
          /** A column the file may leave out; every other column must be present. */
          optional: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  import: z.object({
    keyColumns: z.array(z.string().min(1)).min(1),
    rejectUnknownColumns: z.boolean(),
  }),
});
export type AccountingLayout = z.infer<typeof accountingLayout>;

/** The fields an accounting row can carry, by the `source` of the layout column that carries them. */
export const ROW_SOURCES = {
  investmentNumber: 'investment.investment_number',
  companyName: 'portfolio_company.name',
  periodEnd: 'quarterly_performance.period_end',
  revenueLtm: 'quarterly_performance.revenue_ltm',
  ebitdaLtm: 'quarterly_performance.ebitda_ltm',
  ev: 'quarterly_performance.ev',
  netDebt: 'quarterly_performance.net_debt',
  fairValue: 'valuation.fair_value',
} as const;
export type RowField = keyof typeof ROW_SOURCES;
export const FIGURE_FIELDS = ['revenueLtm', 'ebitdaLtm', 'ev', 'netDebt', 'fairValue'] as const;
export type FigureField = (typeof FIGURE_FIELDS)[number];

/** One line of the export as text: empty cells are null, nothing is parsed yet. */
export interface AccountingRow {
  /** 1-based data line number, the file's own locator for lineage. */
  rowNo: number;
  investmentNumber: string | null;
  companyName: string | null;
  periodEnd: string | null;
  figures: Record<FigureField, string | null>;
  /** Every cell by its column name, for display and lineage. */
  raw: Record<string, string>;
}

export interface AccountingFile {
  rows: AccountingRow[];
  /** Problems with the file as a whole: unknown or missing columns, nothing to read. */
  fileFindings: Finding[];
  /** The column name that carries each field, as the file names it. */
  columns: Partial<Record<RowField, string>>;
}

const LAYOUT_RULE = { id: 'LAYOUT-01', severity: 'error' } as const;
const MISSING_COLUMN = { id: 'LAYOUT-02', severity: 'error' } as const;
const EMPTY_FILE = { id: 'LAYOUT-03', severity: 'error' } as const;
const TOO_MANY = { id: 'LAYOUT-04', severity: 'error' } as const;

const blankToNull = (value: string | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

/**
 * Reads an export against the layout. An unknown column is a file-level error when the layout
 * says so (a renamed column must never be guessed at); a missing non-optional column is always
 * one. Rows are still read past file errors so the reviewer sees what the file holds.
 */
export function readAccountingFile(
  text: string,
  layout: AccountingLayout,
  options: { maxRows: number },
): AccountingFile {
  const table = parseCsv(text);
  const fileFindings: Finding[] = [];
  const known = new Map(layout.export.columns.map((c) => [c.name, c]));
  const headerSet = new Set(table.header);
  for (const name of table.header) {
    if (!known.has(name) && layout.import.rejectUnknownColumns)
      fileFindings.push(
        finding(LAYOUT_RULE, `The file has a column the layout does not know: ${name}`, {
          field: name,
          expected: layout.export.columns.map((c) => c.name).join(', '),
          actual: name,
        }),
      );
  }
  for (const column of layout.export.columns) {
    if (column.optional !== true && !headerSet.has(column.name))
      fileFindings.push(
        finding(MISSING_COLUMN, `The file lacks the column ${column.name}`, {
          field: column.name,
          expected: column.name,
        }),
      );
  }
  if (table.rows.length === 0)
    fileFindings.push(finding(EMPTY_FILE, 'The file has a header and no rows'));
  if (table.rows.length > options.maxRows)
    fileFindings.push(
      finding(TOO_MANY, `The file has more rows than one import takes`, {
        expected: String(options.maxRows),
        actual: String(table.rows.length),
      }),
    );

  const columnFor: Partial<Record<RowField, string>> = {};
  for (const [field, source] of Object.entries(ROW_SOURCES) as [RowField, string][]) {
    const column = layout.export.columns.find((c) => c.source === source);
    if (column !== undefined && headerSet.has(column.name)) columnFor[field] = column.name;
  }
  const index = new Map(table.header.map((name, i) => [name, i]));
  const cell = (line: readonly string[], field: RowField): string | null => {
    const column = columnFor[field];
    if (column === undefined) return null;
    return blankToNull(line[index.get(column) ?? -1]);
  };
  const rows: AccountingRow[] = table.rows.slice(0, options.maxRows).map((line, i) => ({
    rowNo: i + 1,
    investmentNumber: cell(line, 'investmentNumber'),
    companyName: cell(line, 'companyName'),
    periodEnd: cell(line, 'periodEnd'),
    figures: {
      revenueLtm: cell(line, 'revenueLtm'),
      ebitdaLtm: cell(line, 'ebitdaLtm'),
      ev: cell(line, 'ev'),
      netDebt: cell(line, 'netDebt'),
      fairValue: cell(line, 'fairValue'),
    },
    raw: Object.fromEntries(table.header.map((name, c) => [name, line[c] ?? ''])),
  }));
  return { rows, fileFindings, columns: columnFor };
}

/** The natural key of a row for idempotent intake: the layout's key columns, trimmed, joined. */
export function naturalKeyOf(row: AccountingRow, layout: AccountingLayout): string {
  return layout.import.keyColumns.map((name) => (row.raw[name] ?? '').trim()).join('|');
}
