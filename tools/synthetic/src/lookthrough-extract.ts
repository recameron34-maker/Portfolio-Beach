import type { ExposureRow } from '@pb/adapters';
import { D, ONE, addMonths, containingQuarterEnd, summarizeFlows, toDecimalString } from '@pb/calc';
import type { TypedCashFlow } from '@pb/calc';
import type { AliasedDataset } from './aliases.js';
import { aliasesOf } from './aliases.js';
import { activePositions, latestLockedMark, takeRows, walledInvestment } from './marks.js';
import { intakeDecimal } from './settings.js';

/**
 * A synthetic extract from the look-through data provider (docs/04 M2 lookthrough-reconcile):
 * one ExposureRow per active position (every deal type) with a Locked mark on or before the
 * as-of date, in the provider's own vocabulary (plain sector and geography labels, never the
 * taxonomy codes), its exposure at cost (the position's invested capital: the sum of its
 * contributions, as the API reports `invested`) and at NAV (its latest Locked fair value).
 *
 * clean: every row maps and ties, so a reconcile opens no exception.
 * update: three positions' NAV moved by small fractions of intake.lookthroughNavTolerancePct,
 *   inside the tolerance, so they pass; the rest unchanged.
 * defects: update plus one row per difference the reconcile exists for, each on its own row.
 *
 * One row in every scenario carries one of the company's aliases and no number: it must still
 * link. The walled position's rows are reported like the accounting export's, and in defects its
 * hidden flagged row is the one with the as-of a quarter old.
 */
export type LookthroughScenario = 'clean' | 'update' | 'defects';

export interface LookthroughExtractOptions {
  /** The extract's as-of date; the dataset's as-of date by default. */
  asOf?: string;
  scenario?: LookthroughScenario;
}

export type LookthroughField = 'exposureAtNav' | 'exposureAtCost' | 'sector' | 'geography' | 'asOf';

export interface LookthroughExpectations {
  rows: number;
  /** Rows the reconcile must raise, by the field that differs from the record beyond tolerance. */
  differences: { rowNo: number; field: LookthroughField }[];
  /** Rows whose NAV moved inside the tolerance, with the move as a signed decimal of the record's NAV. */
  moved: { rowNo: number; field: 'exposureAtNav'; pct: string }[];
  /** Rows no position matches: an unknown number, or a near miss on a name with no number. */
  unmatched: number[];
  /** Rows carrying a sector label the mapping does not list. */
  unmapped: number[];
  /** Rows that repeat an earlier row (the same position and as-of date). */
  duplicates: number[];
  /** Rows carrying an alias in place of the company name and no number: they link by the alias. */
  aliased: number[];
  /** The row numbers of every row of the walled position (walled_deal). */
  walled: number[];
}

export interface LookthroughExtract {
  /** The name a bundle or the preview keeps the extract under. */
  fileName: string;
  /** The name the folder look-through provider reads the extract by, inside its folder. */
  dropName: string;
  asOf: string;
  rows: ExposureRow[];
  /** The file text: the rows as a JSON array, two-space indented, with a final line feed. */
  json: string;
  expectations: LookthroughExpectations;
}

/**
 * The provider's labels for the taxonomy codes the generator uses: the small table
 * config/lookthrough_mapping.json is checked against. A code the generator starts using must be
 * added here, or the extract stops with an error rather than guessing a label.
 */
export const PROVIDER_LABELS = {
  sector: {
    'sector.software': 'Technology',
    'sector.healthcare': 'Healthcare',
    'sector.industrials': 'Industrials',
    'sector.consumer': 'Consumer',
    'sector.business_services': 'Business Services',
    'sector.financials': 'Financials',
    'sector.energy_transition': 'Energy',
  },
  geography: {
    'geography.north_america': 'North America',
    'geography.europe': 'Europe',
    'geography.asia_pacific': 'Asia Pacific',
    'geography.other': 'Rest of World',
  },
} as const satisfies Record<'sector' | 'geography', Record<string, string>>;

/** A sector label the provider uses that the mapping deliberately leaves unmapped. */
export const UNMAPPED_SECTOR_LABEL = 'Other';

/** Every label the provider's extracts can carry, the unmapped one included. */
export const PROVIDER_VOCABULARY = {
  sector: [...Object.values(PROVIDER_LABELS.sector), UNMAPPED_SECTOR_LABEL],
  geography: [...Object.values(PROVIDER_LABELS.geography)],
} as const;

/** The three moves of the update scenario, as fractions of the NAV tolerance: all inside it. */
export const LOOKTHROUGH_MOVES = ['0.3', '-0.45', '0.6'] as const;
/** The NAV move of the defects scenario's flagged position, as a multiple of the tolerance. */
export const LOOKTHROUGH_MOVE_BEYOND = '1.5';
/** The cost difference of the defects scenario's flagged position, as a multiple of the tolerance. */
export const LOOKTHROUGH_COST_BEYOND = '10';

function labelFor(kind: 'sector' | 'geography', code: string | null, where: string): string {
  const table: Record<string, string> = PROVIDER_LABELS[kind];
  const label = code === null ? undefined : table[code];
  if (label === undefined)
    throw new Error(`${where}: no provider ${kind} label for taxonomy code ${code ?? 'null'}`);
  return label;
}

/** The flow kind packages/calc expects: the taxonomy code without its domain prefix. */
const kindOf = (flowType: string): TypedCashFlow['kind'] =>
  flowType.replace('flow_type.', '') as TypedCashFlow['kind'];

/**
 * A position's invested capital on the as-of date, as the API computes `invested`: the sum of
 * its approved contributions dated on or before that date (summarizeFlows in @pb/calc). Null
 * when nothing was contributed, which no generated position has.
 */
export function investedCost(
  dataset: AliasedDataset,
  investmentId: string,
  asOf: string,
): string | null {
  const flows: TypedCashFlow[] = dataset.cashFlows
    .filter(
      (f) =>
        f.investmentId === investmentId &&
        f.status === 'record_status.approved' &&
        f.flowDate <= asOf,
    )
    .map((f) => ({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount }));
  const contributions = summarizeFlows(flows).contributions;
  return contributions.isZero() ? null : toDecimalString(contributions);
}

const moved = (value: string, pct: string): string =>
  toDecimalString(D(value).times(ONE.plus(pct)).toDecimalPlaces(2)) ?? value;

export function lookthroughExtract(
  dataset: AliasedDataset,
  options: LookthroughExtractOptions = {},
): LookthroughExtract {
  const scenario = options.scenario ?? 'clean';
  const asOf = options.asOf ?? dataset.asOf;
  const navTolerance = intakeDecimal('lookthroughNavTolerancePct');
  const costTolerance = intakeDecimal('lookthroughCostToleranceUsd');
  const companies = new Map(dataset.portfolioCompanies.map((c) => [c.id, c]));

  const rows: ExposureRow[] = [];
  const companyOf: string[] = [];
  for (const inv of activePositions(dataset)) {
    const company = companies.get(inv.portfolioCompanyId);
    const mark = latestLockedMark(dataset.valuations, inv.id, asOf);
    const cost = investedCost(dataset, inv.id, asOf);
    if (company === undefined || mark === null || cost === null) continue;
    rows.push({
      investmentNumber: inv.investmentNumber,
      companyName: company.name,
      sector: labelFor('sector', company.sector, company.name),
      geography: labelFor('geography', company.geography, company.name),
      exposureAtCost: cost,
      exposureAtNav: toDecimalString(D(mark.fairValue)) ?? mark.fairValue,
      asOf,
    });
    companyOf.push(company.id);
  }
  const positions = rows.length;
  const expectations: LookthroughExpectations = {
    rows: 0,
    differences: [],
    moved: [],
    unmatched: [],
    unmapped: [],
    duplicates: [],
    aliased: [],
    walled: [],
  };
  const walled = walledInvestment(dataset);
  const walledIndex = rows.findIndex((r) => r.investmentNumber === walled?.investmentNumber);
  if (walledIndex >= 0) expectations.walled.push(walledIndex + 1);
  const taken = new Set<number>([walledIndex]);

  // The alias row: the first position outside the wall whose company has an alias, by that alias
  // and no number.
  const aliasIndex = rows.findIndex(
    (_, i) => i !== walledIndex && aliasesOf(dataset, companyOf[i] ?? '').length > 0,
  );
  if (aliasIndex >= 0) {
    const row = rows[aliasIndex];
    const alias = aliasesOf(dataset, companyOf[aliasIndex] ?? '')[0];
    if (row !== undefined && alias !== undefined) {
      row.investmentNumber = null;
      row.companyName = alias;
      expectations.aliased.push(aliasIndex + 1);
      taken.add(aliasIndex);
    }
  }

  if (scenario !== 'clean') {
    // Three positions' NAV moved inside the tolerance: the reconcile lets them pass.
    for (const [k, index] of takeRows(positions, taken, LOOKTHROUGH_MOVES.length).entries()) {
      const row = rows[index];
      const fraction = LOOKTHROUGH_MOVES[k];
      if (row === undefined || fraction === undefined) continue;
      const pct = D(navTolerance).times(fraction).toFixed();
      row.exposureAtNav = moved(row.exposureAtNav, pct);
      expectations.moved.push({ rowNo: index + 1, field: 'exposureAtNav', pct });
    }
  }

  if (scenario === 'defects') {
    const changed = (want: number): { index: number; row: ExposureRow }[] =>
      takeRows(positions, taken, want).flatMap((index) => {
        const row = rows[index];
        return row === undefined ? [] : [{ index, row }];
      });
    // A NAV beyond the tolerance.
    for (const { index, row } of changed(1)) {
      row.exposureAtNav = moved(
        row.exposureAtNav,
        D(navTolerance).times(LOOKTHROUGH_MOVE_BEYOND).toFixed(),
      );
      expectations.differences.push({ rowNo: index + 1, field: 'exposureAtNav' });
    }
    // A cost off by more than the dollar tolerance.
    for (const { index, row } of changed(1)) {
      row.exposureAtCost =
        toDecimalString(
          D(row.exposureAtCost).plus(D(costTolerance).times(LOOKTHROUGH_COST_BEYOND)),
        ) ?? row.exposureAtCost;
      expectations.differences.push({ rowNo: index + 1, field: 'exposureAtCost' });
    }
    // A sector label the mapping leaves unmapped.
    for (const { index, row } of changed(1)) {
      row.sector = UNMAPPED_SECTOR_LABEL;
      expectations.unmapped.push(index + 1);
    }
    // A sector label that maps, onto a different code than the record's.
    for (const { index, row } of changed(1)) {
      row.sector =
        Object.values(PROVIDER_LABELS.sector).find((l) => l !== row.sector) ?? row.sector;
      expectations.differences.push({ rowNo: index + 1, field: 'sector' });
    }
    // The rows below are appended, each built from a position row that carries its number and
    // sits outside the wall.
    const sample = rows.find((r, i) => i < positions && i !== walledIndex && i !== aliasIndex);
    if (sample !== undefined) {
      // A company the record lacks.
      rows.push({
        ...sample,
        investmentNumber: 'INV-9999',
        companyName: 'Harbor Example Holdings',
      });
      expectations.unmatched.push(rows.length);
      // A near miss on the name with no number: candidates for a person, never a link.
      rows.push({
        ...sample,
        investmentNumber: null,
        companyName: sample.companyName.slice(0, -1),
      });
      expectations.unmatched.push(rows.length);
      // The same position and as-of date twice.
      rows.push({ ...sample });
      expectations.duplicates.push(rows.length);
    }
    // An as-of a quarter old, built from the walled position so the wall tests have a hidden
    // flagged row; from the first row when the dataset has no wall.
    const base = rows[walledIndex] ?? rows[0];
    if (base !== undefined) {
      rows.push({ ...base, asOf: containingQuarterEnd(addMonths(asOf, -3)) });
      expectations.differences.push({ rowNo: rows.length, field: 'asOf' });
      if (walledIndex >= 0) expectations.walled.push(rows.length);
    }
  }

  expectations.rows = rows.length;
  const suffix = scenario === 'clean' ? '' : `-${scenario}`;
  return {
    fileName: `lookthrough-${asOf}${suffix}.json`,
    dropName: `${asOf}${suffix}.json`,
    asOf,
    rows,
    json: `${JSON.stringify(rows, null, 2)}\n`,
    expectations,
  };
}

/** The three sample extracts a drop folder or the preview ships with. */
export function lookthroughExtracts(dataset: AliasedDataset): LookthroughExtract[] {
  return (['clean', 'update', 'defects'] as const).map((scenario) =>
    lookthroughExtract(dataset, { scenario }),
  );
}
