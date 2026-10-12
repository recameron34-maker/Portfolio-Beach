import { D, addMonths, containingQuarterEnd, latestQuarterEndOnOrBefore } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import layout from '../../../config/accounting_layout.json' with { type: 'json' };

/**
 * A synthetic export from the accounting system in the generic layout of
 * config/accounting_layout.json (docs/04 M2 accounting-import, docs/14): one row per active equity
 * or CV position for the latest approved quarter, with the Locked fair value for that quarter.
 *
 * clean: every row matches the record, so an import stages nothing but unchanged rows.
 * update: one position restated (changed) and the quarter the missing_prior_year scenario left
 *   out supplied (new), the rest unchanged.
 * defects: update plus every defect the validation rules exist for, each on its own row.
 */
export type ExportScenario = 'clean' | 'update' | 'defects';

export interface AccountingExportOptions {
  scenario?: ExportScenario;
  /** The quarter to export; the latest quarter end on or before the as-of date by default. */
  periodEnd?: string;
}

export interface AccountingExportExpectations {
  rows: number;
  /** Investment numbers whose row differs from the record. */
  changed: string[];
  /** Investment numbers with a quarter the record lacks. */
  added: string[];
  /** Rows the import must flag, by the rule a reviewer sees first. */
  flagged: { rowNo: number; ruleId: string }[];
}

export interface AccountingExport {
  fileName: string;
  csv: string;
  header: string[];
  expectations: AccountingExportExpectations;
}

type Investment = SyntheticDataset['investments'][number];
type Quarter = SyntheticDataset['quarterlyPerformance'][number];

interface Line {
  investmentNumber: string;
  companyName: string;
  periodEnd: string;
  revenueLtm: string;
  ebitdaLtm: string;
  ev: string;
  netDebt: string;
  fairValue: string;
}

const SOURCE_FIELD: Record<string, keyof Line> = {
  'investment.investment_number': 'investmentNumber',
  'portfolio_company.name': 'companyName',
  'quarterly_performance.period_end': 'periodEnd',
  'quarterly_performance.revenue_ltm': 'revenueLtm',
  'quarterly_performance.ebitda_ltm': 'ebitdaLtm',
  'quarterly_performance.ev': 'ev',
  'quarterly_performance.net_debt': 'netDebt',
  'valuation.fair_value': 'fairValue',
};

const cell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const scale = (value: string | null, factor: string): string =>
  value === null ? '' : D(value).times(factor).toFixed(2);

const midpoint = (a: string | null, b: string | null): string => {
  if (a === null && b === null) return '';
  if (a === null) return D(b ?? '0').toFixed(2);
  if (b === null) return D(a).toFixed(2);
  return D(a).plus(b).div(2).toFixed(2);
};

export function accountingExport(
  dataset: SyntheticDataset,
  options: AccountingExportOptions = {},
): AccountingExport {
  const scenario = options.scenario ?? 'clean';
  const asOfQuarter = latestQuarterEndOnOrBefore(dataset.asOf);
  const periodEnd = options.periodEnd ?? asOfQuarter;
  const companyName = new Map(dataset.portfolioCompanies.map((c) => [c.id, c.name]));
  const quartersOf = (inv: Investment): Quarter[] =>
    dataset.quarterlyPerformance
      .filter((q) => q.investmentId === inv.id && q.status === 'record_status.approved')
      .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0));
  const lockedFairValue = (inv: Investment, quarter: string): string => {
    const marks = dataset.valuations
      .filter((v) => v.investmentId === inv.id && v.state === 'Locked' && v.periodEnd === quarter)
      .sort((a, b) => b.version - a.version);
    return marks[0]?.fairValue ?? '';
  };
  const lineFor = (inv: Investment, q: Quarter): Line => ({
    investmentNumber: inv.investmentNumber,
    companyName: companyName.get(inv.portfolioCompanyId) ?? '',
    periodEnd: q.periodEnd,
    revenueLtm: q.revenueLtm ?? '',
    ebitdaLtm: q.ebitdaLtm ?? '',
    ev: q.ev ?? '',
    netDebt: q.netDebt ?? '',
    fairValue: lockedFairValue(inv, q.periodEnd),
  });

  const equity = dataset.investments
    .filter((i) => i.isActive && i.dealType !== 'deal_type.private_credit')
    .sort((a, b) => a.investmentNumber.localeCompare(b.investmentNumber));
  const lines: Line[] = [];
  for (const inv of equity) {
    const quarter = quartersOf(inv).find((q) => !q.isEntrySnapshot && q.periodEnd === periodEnd);
    if (quarter !== undefined) lines.push(lineFor(inv, quarter));
  }
  const expectations: AccountingExportExpectations = {
    rows: 0,
    changed: [],
    added: [],
    flagged: [],
  };
  const byNumber = (n: string): Investment | undefined =>
    equity.find((i) => i.investmentNumber === n);

  const missingId = dataset.scenarios.missing_prior_year?.[0];
  const missing = equity.find((i) => i.id === missingId);
  if (scenario !== 'clean') {
    // Restated: a position's EBITDA down 4% and revenue up 2% (not the one that gets a new quarter).
    const first = lines.find((l) => l.investmentNumber !== missing?.investmentNumber);
    if (first !== undefined) {
      first.ebitdaLtm = scale(first.ebitdaLtm || null, '0.96');
      first.revenueLtm = scale(first.revenueLtm || null, '1.02');
      expectations.changed.push(first.investmentNumber);
    }
    // The quarter the missing_prior_year scenario removed, supplied from its neighbours.
    if (missing !== undefined) {
      const rows = quartersOf(missing).filter((q) => !q.isEntrySnapshot);
      const latest = rows[rows.length - 1];
      if (latest !== undefined) {
        const wanted = addMonths(latest.periodEnd, -12);
        const before = rows.filter((q) => q.periodEnd < wanted).pop() ?? null;
        const after = rows.find((q) => q.periodEnd > wanted) ?? null;
        lines.push({
          investmentNumber: missing.investmentNumber,
          companyName: companyName.get(missing.portfolioCompanyId) ?? '',
          periodEnd: wanted,
          revenueLtm: midpoint(before?.revenueLtm ?? null, after?.revenueLtm ?? null),
          ebitdaLtm: midpoint(before?.ebitdaLtm ?? null, after?.ebitdaLtm ?? null),
          ev: midpoint(before?.ev ?? null, after?.ev ?? null),
          netDebt: midpoint(before?.netDebt ?? null, after?.netDebt ?? null),
          fairValue: '',
        });
        expectations.added.push(missing.investmentNumber);
      }
    }
  }

  if (scenario === 'defects') {
    const flag = (ruleId: string): void => {
      expectations.flagged.push({ rowNo: lines.length, ruleId });
    };
    const sample = lines[1] ?? lines[0];
    if (sample !== undefined) {
      // An investment number the record does not have.
      lines.push({
        ...sample,
        investmentNumber: 'INV-9999',
        companyName: 'Harbor Example Holdings',
      });
      flag('XREF-01');
      // A near miss on the name with no number: candidates for a person, never a link.
      lines.push({ ...sample, investmentNumber: '', companyName: sample.companyName.slice(0, -1) });
      flag('XREF-01');
    }
    // A name on the match guard list: never linked.
    const guard = dataset.matchGuards[0];
    const guardedSample = lines[2] ?? sample;
    if (guard !== undefined && guardedSample !== undefined) {
      lines.push({ ...guardedSample, investmentNumber: '', companyName: guard.nameB });
      flag('XREF-02');
    }
    // The same investment and period twice.
    const third = lines[3] ?? sample;
    if (third !== undefined) {
      lines.push({ ...third });
      flag('DUP-01');
    }
    // Revenue entered in millions.
    const fourth = lines[4];
    if (fourth !== undefined) {
      fourth.revenueLtm = scale(fourth.revenueLtm || null, '0.000001');
      expectations.flagged.push({ rowNo: 5, ruleId: 'TYPE-04' });
    }
    // A fair value that does not tie to the Locked mark: the first untouched row that has one.
    const tieIndex = lines.findIndex(
      (l, i) => i >= 5 && i !== 6 && i !== 7 && l.fairValue !== '' && l.periodEnd === periodEnd,
    );
    const tie = lines[tieIndex];
    if (tie !== undefined) {
      tie.fairValue = scale(tie.fairValue, '1.1');
      expectations.flagged.push({ rowNo: tieIndex + 1, ruleId: 'TIE-01' });
    }
    // A period end two weeks before the quarter end: a warning, not a flag.
    const sixth = lines[6];
    if (sixth !== undefined) sixth.periodEnd = `${sixth.periodEnd.slice(0, 8)}16`;
    // A quarter before the position was entered.
    const seventh = lines[7];
    const seventhInv = seventh === undefined ? undefined : byNumber(seventh.investmentNumber);
    if (seventh !== undefined && seventhInv !== undefined) {
      lines.push({
        ...seventh,
        periodEnd: containingQuarterEnd(addMonths(seventhInv.entryDate, -9)),
        fairValue: '',
      });
      flag('PERIOD-01');
    }
    // A private credit position in an equity export.
    const credit = dataset.investments.find(
      (i) => i.isActive && i.dealType === 'deal_type.private_credit',
    );
    if (credit !== undefined && sample !== undefined) {
      lines.push({
        ...sample,
        investmentNumber: credit.investmentNumber,
        companyName: companyName.get(credit.portfolioCompanyId) ?? '',
        fairValue: '',
      });
      flag('XREF-05');
    }
  }

  expectations.rows = lines.length;
  const header = layout.export.columns.map((c) => c.name);
  const fields = layout.export.columns.map((c) => SOURCE_FIELD[c.source] ?? 'companyName');
  const body = lines.map((line) => fields.map((f) => cell(line[f])).join(','));
  return {
    fileName: `accounting-export-${periodEnd}-${scenario}.csv`,
    csv: `${[header.join(','), ...body].join('\n')}\n`,
    header,
    expectations,
  };
}

/** The three sample exports a drop folder or the preview ships with. */
export function accountingExports(dataset: SyntheticDataset): AccountingExport[] {
  return (['clean', 'update', 'defects'] as const).map((scenario) =>
    accountingExport(dataset, { scenario }),
  );
}
