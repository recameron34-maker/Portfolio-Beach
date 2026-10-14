import type { SyntheticDataset } from '@pb/db';
import { accountingExport } from './accounting-export.js';
import type { AccountingExportExpectations, ExportScenario } from './accounting-export.js';

/**
 * The sheets of a synthetic operations workbook (docs/04 M2 ops-drop-import), template
 * `quarterly-figures`: a Figures sheet with the header config/ops_drop_templates.json names and
 * the same rows the accounting export carries for the scenario (taken from it, never derived
 * again), and a Notes sheet of two text rows. A pure function of the dataset: the XLSX writer
 * (packages/xlsx, writeWorkbook) wraps these sheets into a file in a later step.
 *
 * clean, update, defects: the accounting export's scenario and its expectations.
 * unknown-template: the clean rows under a Figures header that differs in one column name, so
 *   the import refuses the workbook (its signature matches no template) and stages nothing.
 */
export type OpsDropScenario = ExportScenario | 'unknown-template';

export interface OpsDropOptions {
  scenario?: OpsDropScenario;
  /** The quarter the figures are for; the accounting export's default quarter when absent. */
  periodEnd?: string;
}

export interface OpsDropSheet {
  name: string;
  rows: string[][];
}

export interface OpsDropExpectations extends AccountingExportExpectations {
  /** True when the import must refuse the workbook as an unknown template; nothing is staged then. */
  refused: boolean;
}

export interface OpsDropSample {
  scenario: OpsDropScenario;
  fileName: string;
  /** The template the Figures header is written for; a refused workbook is written for none. */
  template: string | null;
  periodEnd: string;
  sheets: OpsDropSheet[];
  expectations: OpsDropExpectations;
}

export const OPS_DROP_TEMPLATE = 'quarterly-figures';
export const OPS_DROP_SHEET_NAMES = ['Figures', 'Notes'] as const;

/** The Figures header cells, each with the accounting layout column it carries. */
export const OPS_DROP_COLUMNS = [
  { name: 'Investment number', layoutColumn: 'InvestmentNumber' },
  { name: 'Company', layoutColumn: 'CompanyName' },
  { name: 'Period end', layoutColumn: 'PeriodEnd' },
  { name: 'Revenue LTM', layoutColumn: 'RevenueLTM' },
  { name: 'EBITDA LTM', layoutColumn: 'EBITDALTM' },
  { name: 'Enterprise value', layoutColumn: 'EnterpriseValue' },
  { name: 'Net debt', layoutColumn: 'NetDebt' },
  { name: 'Fair value', layoutColumn: 'FairValue' },
] as const;

export const OPS_DROP_FIGURES_HEADER: string[] = OPS_DROP_COLUMNS.map((c) => c.name);

/** The one header cell the unknown-template scenario renames, and its name there. */
export const OPS_DROP_UNKNOWN_HEADER_CELL = { name: 'Revenue LTM', renamed: 'Revenue (LTM)' };

export const OPS_DROP_NOTES_PREPARED_BY = 'Prepared by operations';

export function opsDropSheets(
  dataset: SyntheticDataset,
  options: OpsDropOptions = {},
): OpsDropSample {
  const scenario = options.scenario ?? 'clean';
  const refused = scenario === 'unknown-template';
  const exported = accountingExport(dataset, {
    scenario: refused ? 'clean' : scenario,
    ...(options.periodEnd === undefined ? {} : { periodEnd: options.periodEnd }),
  });
  // Each Figures column takes its cells from the export column it carries, by that column's name.
  const indexes = OPS_DROP_COLUMNS.map((c) => {
    const index = exported.header.indexOf(c.layoutColumn);
    if (index < 0) throw new Error(`the accounting layout has no column ${c.layoutColumn}`);
    return index;
  });
  const header = OPS_DROP_FIGURES_HEADER.map((name) =>
    refused && name === OPS_DROP_UNKNOWN_HEADER_CELL.name
      ? OPS_DROP_UNKNOWN_HEADER_CELL.renamed
      : name,
  );
  const periodEnd = exported.periodEnd;
  const figures = [header, ...exported.rows.map((row) => indexes.map((i) => row[i] ?? ''))];
  return {
    scenario,
    fileName: `ops-drop-${periodEnd}-${scenario}.xlsx`,
    template: refused ? null : OPS_DROP_TEMPLATE,
    periodEnd,
    sheets: [
      { name: OPS_DROP_SHEET_NAMES[0], rows: figures },
      { name: OPS_DROP_SHEET_NAMES[1], rows: [[OPS_DROP_NOTES_PREPARED_BY], [periodEnd]] },
    ],
    expectations: { ...exported.expectations, refused },
  };
}

/** The four sample workbooks a drop folder or the preview ships with. */
export function opsDropSamples(dataset: SyntheticDataset): OpsDropSample[] {
  return (['clean', 'update', 'defects', 'unknown-template'] as const).map((scenario) =>
    opsDropSheets(dataset, { scenario }),
  );
}
