import { D } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import { z } from 'zod';
import { linkInvestment, normalizeName } from '../linking.js';
import type {
  InvestmentDirectoryEntry,
  LinkCandidate,
  LinkResult,
  LinkStatus,
  MatchGuardPair,
} from '../linking.js';
import { IntakeSettingsError } from '../settings.js';
import { finding, runRules, statusFromFindings } from '../types.js';
import type { Finding, Rule } from '../types.js';
import { isCalendarDate } from '@pb/calc';

/*
 * The look-through reconcile rules (docs/04 M2 lookthrough-reconcile, decision 0010): the
 * provider's extract for one as-of date is linked to the book, its labels are mapped onto the
 * taxonomy and its exposures are compared with the approved values. A difference is reported and
 * opens a data exception; nothing on record ever changes from a provider file (docs/04 M1: outside
 * sources are mapped to the taxonomy and never override it). The API runs these over the database
 * and a preview may run them over a bundled book, so everything here is pure: no clock, no
 * randomness, no floats (docs/17 section 4).
 */

/** The thresholds the rules read from config/definitions.json (CLAUDE.md rule 9), never from literals here. */
export interface LookthroughRuleConfig {
  /** The move of the provider's NAV against the record's, as a decimal of the record's NAV (0.02 = 2%), the reconcile lets pass (intake.lookthroughNavTolerancePct). */
  navTolerancePct: string;
  /** The dollars the provider's cost may sit from the invested cost before it is a difference (intake.lookthroughCostToleranceUsd). */
  costToleranceUsd: string;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A rate or threshold as plain decimal digits (never exponent form), from a JSON number or a decimal string. */
const decimalDigits = z
  .union([z.number(), z.string().regex(DECIMAL)])
  .transform((value) => D(typeof value === 'number' ? String(value) : value).toFixed());

/** Only the two keys the reconcile reads; the rest of the definitions file is ignored here. */
export const lookthroughDefinitions = z.object({
  intake: z.object({
    lookthroughNavTolerancePct: decimalDigits,
    lookthroughCostToleranceUsd: decimalDigits,
  }),
});

/** The reconcile thresholds from the parsed definitions file, or an IntakeSettingsError naming the first bad key. */
export function lookthroughRuleConfigFrom(definitions: unknown): LookthroughRuleConfig {
  const parsed = lookthroughDefinitions.safeParse(definitions);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String) ?? [];
    throw new IntakeSettingsError(path.length === 0 ? 'intake' : path.join('.'));
  }
  return {
    navTolerancePct: parsed.data.intake.lookthroughNavTolerancePct,
    costToleranceUsd: parsed.data.intake.lookthroughCostToleranceUsd,
  };
}

/**
 * One provider row with its data line: the adapter's ExposureRow (packages/adapters) plus rowNo.
 * The shape is restated here so the rules depend on no adapter.
 */
export interface LookthroughRow {
  rowNo: number;
  investmentNumber: string | null;
  companyName: string;
  sector: string;
  geography: string;
  exposureAtCost: string;
  exposureAtNav: string;
  asOf: string;
}

/** A provider row with the link the reconcile made for it. */
export interface LookthroughLinkedRow {
  row: LookthroughRow;
  link: LinkResult;
}

/** What config/lookthrough_mapping.json makes of the provider's labels: a taxonomy code, or null for a label it does not list. */
export interface LookthroughMapped {
  sector: string | null;
  geography: string | null;
}

/** The provider's vocabulary mapped onto the taxonomy: the shape of config/lookthrough_mapping.json. */
export interface LookthroughLabelMapping {
  sector: Readonly<Record<string, string>>;
  geography: Readonly<Record<string, string>>;
}

/**
 * What is on record for the linked position: the company's taxonomy codes and the approved
 * exposures (invested cost as the API computes it, the latest Locked mark on or before the run's
 * as-of date). A figure the record lacks is null and is never compared (CLAUDE.md rule 10).
 */
export interface LookthroughRecord {
  sector: string | null;
  geography: string | null;
  exposureAtCost: string | null;
  exposureAtNav: string | null;
}

export interface LookthroughRuleContext {
  row: LookthroughRow;
  link: LinkResult;
  /** Every row of the extract with its link, for the duplicate rule. */
  file: readonly LookthroughLinkedRow[];
  mapped: LookthroughMapped;
  /** The record for the linked position; null when the row is not linked. */
  record: LookthroughRecord | null;
  /** The run's as-of date: the date the extract and the record are compared for. */
  asOf: string;
  config: LookthroughRuleConfig;
}

type LookthroughRule = Rule<LookthroughRuleContext>;

/** The fields a provider row is compared on: the differences a reconcile can report (packages/contracts lookthroughField). */
export const LOOKTHROUGH_FIELDS = [
  'sector',
  'geography',
  'exposureAtCost',
  'exposureAtNav',
] as const;
export type LookthroughDifferenceField = (typeof LOOKTHROUGH_FIELDS)[number];

const EXPOSURE_FIELDS = ['exposureAtCost', 'exposureAtNav'] as const;
type ExposureField = (typeof EXPOSURE_FIELDS)[number];
const EXPOSURE_LABEL: Record<ExposureField, string> = {
  exposureAtCost: 'exposure at cost',
  exposureAtNav: 'exposure at NAV',
};

const blank = (value: string | null): boolean => value === null || value.trim() === '';

/** True when the row names no position: both the investment number and the company name are blank. */
const nameless = (row: Pick<LookthroughRow, 'investmentNumber' | 'companyName'>): boolean =>
  blank(row.investmentNumber) && blank(row.companyName);

/** The figure as a Decimal when it is a well-formed decimal string, else null. */
const decimal = (value: string | null): Decimal | null =>
  value !== null && DECIMAL.test(value.trim()) ? D(value.trim()) : null;

const pct = (d: Decimal): string => `${d.times(100).toFixed(1)}%`;

/** The provider's label as the mapping lists it (trimmed, exact), or null. */
function lookup(table: Readonly<Record<string, string>>, label: string): string | null {
  const key = label.trim();
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** The taxonomy codes the mapping gives the row's labels; a label it does not list maps to nothing. */
export function mapLabels(
  mapping: LookthroughLabelMapping,
  row: Pick<LookthroughRow, 'sector' | 'geography'>,
): LookthroughMapped {
  return {
    sector: lookup(mapping.sector, row.sector),
    geography: lookup(mapping.geography, row.geography),
  };
}

/** Every row of the extract with the link the reconcile made for it, in file order (docs/03 section 5). */
export function linkLookthroughRows(
  rows: readonly LookthroughRow[],
  directory: readonly InvestmentDirectoryEntry[],
  guards: readonly MatchGuardPair[],
): LookthroughLinkedRow[] {
  return rows.map((row) => ({ row, link: linkInvestment(row, directory, guards) }));
}

/** The number as written, else the name, then the row's as-of date: the natural key of a staged row within a run. */
export function lookthroughNaturalKey(row: LookthroughRow): string {
  const who = blank(row.investmentNumber)
    ? row.companyName.trim()
    : (row.investmentNumber ?? '').trim();
  return `${who}|${row.asOf}`;
}

/* ---- Required ---- */
const LT_REQ_01: LookthroughRule = {
  id: 'LT-REQ-01',
  category: 'required',
  severity: 'error',
  title: 'A number or a name identifies the row, and both exposures are present',
  check: ({ row }) => {
    const out: Finding[] = [];
    if (nameless(row))
      out.push(
        finding(
          LT_REQ_01,
          'The row names no position: both the investment number and the company name are blank',
          { field: 'investmentNumber' },
        ),
      );
    for (const field of EXPOSURE_FIELDS)
      if (blank(row[field]))
        out.push(finding(LT_REQ_01, `The ${EXPOSURE_LABEL[field]} is blank`, { field }));
    return out;
  },
};

/* ---- Types and units ---- */
const LT_TYPE_01: LookthroughRule = {
  id: 'LT-TYPE-01',
  category: 'types_units',
  severity: 'error',
  title: 'Every exposure is a plain decimal number and the as-of is a calendar date',
  check: ({ row }) => {
    const out: Finding[] = EXPOSURE_FIELDS.filter(
      (field) => !blank(row[field]) && decimal(row[field]) === null,
    ).map((field) =>
      finding(
        LT_TYPE_01,
        `The ${EXPOSURE_LABEL[field]} is not a plain number (digits, a sign and a decimal point only)`,
        { field, expected: 'a decimal number', actual: row[field] },
      ),
    );
    if (!isCalendarDate(row.asOf))
      out.push(
        finding(LT_TYPE_01, 'The as-of date is not a date of the form YYYY-MM-DD', {
          field: 'asOf',
          expected: 'YYYY-MM-DD',
          actual: row.asOf,
        }),
      );
    return out;
  },
};

/* ---- Cross-entity: the link ---- */
// The XREF messages name no candidate and count none: candidates travel on the link, where a reader
// sees the ones they may see, so a finding reads the same for everyone (walls, SEC-5.3).
const LT_XREF_01: LookthroughRule = {
  id: 'LT-XREF-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The row links to a position on record',
  check: ({ link, row }) =>
    link.status === 'unmatched' && !nameless(row)
      ? finding(
          LT_XREF_01,
          'No position on record matches the number or the name; any candidates a person may see are listed on the row',
          { field: blank(row.investmentNumber) ? 'companyName' : 'investmentNumber' },
        )
      : null,
};
const LT_XREF_02: LookthroughRule = {
  id: 'LT-XREF-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name on the match guard list is never linked',
  check: ({ link }) =>
    link.status === 'guarded'
      ? finding(
          LT_XREF_02,
          'The company name is on the match guard list and is never linked automatically; a person decides',
          { field: 'companyName' },
        )
      : null,
};
const LT_XREF_03: LookthroughRule = {
  id: 'LT-XREF-03',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name resolves to one position',
  check: ({ link }) =>
    link.status === 'ambiguous'
      ? finding(
          LT_XREF_03,
          'The company name resolves to more than one position on record; a person must pick one from the candidates they may see on the row',
          { field: 'companyName' },
        )
      : null,
};

/* ---- Cross-entity: the taxonomy ---- */
const LT_MAP_01: LookthroughRule = {
  id: 'LT-MAP-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The sector label is in the mapping',
  check: ({ row, mapped }) =>
    mapped.sector === null
      ? finding(
          LT_MAP_01,
          'The sector label is not in config/lookthrough_mapping.json; the taxonomy is never guessed from a label',
          { field: 'sector', expected: 'a sector label the mapping lists', actual: row.sector },
        )
      : null,
};
const LT_MAP_02: LookthroughRule = {
  id: 'LT-MAP-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'The geography label is in the mapping',
  check: ({ row, mapped }) =>
    mapped.geography === null
      ? finding(
          LT_MAP_02,
          'The geography label is not in config/lookthrough_mapping.json; the taxonomy is never guessed from a label',
          {
            field: 'geography',
            expected: 'a geography label the mapping lists',
            actual: row.geography,
          },
        )
      : null,
};

/** "Healthcare (sector.healthcare)": the provider's label with the code it maps to, as a difference reads. */
const labelled = (label: string, code: string): string => `${label.trim()} (${code})`;

const LT_DIFF_01: LookthroughRule = {
  id: 'LT-DIFF-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The mapped sector agrees with the record',
  check: ({ row, mapped, record }) =>
    mapped.sector !== null &&
    record !== null &&
    record.sector !== null &&
    mapped.sector !== record.sector
      ? finding(
          LT_DIFF_01,
          `The provider's sector maps to ${mapped.sector}; on record the company is ${record.sector}`,
          {
            field: 'sector',
            expected: record.sector,
            actual: labelled(row.sector, mapped.sector),
          },
        )
      : null,
};
const LT_DIFF_02: LookthroughRule = {
  id: 'LT-DIFF-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'The mapped geography agrees with the record',
  check: ({ row, mapped, record }) =>
    mapped.geography !== null &&
    record !== null &&
    record.geography !== null &&
    mapped.geography !== record.geography
      ? finding(
          LT_DIFF_02,
          `The provider's geography maps to ${mapped.geography}; on record the company is ${record.geography}`,
          {
            field: 'geography',
            expected: record.geography,
            actual: labelled(row.geography, mapped.geography),
          },
        )
      : null,
};

/* ---- Totals that tie ---- */
const LT_TIE_01: LookthroughRule = {
  id: 'LT-TIE-01',
  category: 'totals_tie',
  severity: 'error',
  title: 'The exposure at NAV ties to the latest Locked mark within the tolerance',
  check: ({ row, record, config }) => {
    const provider = decimal(row.exposureAtNav);
    const mark = decimal(record?.exposureAtNav ?? null);
    if (provider === null || mark === null) return null;
    const gap = provider.minus(mark).abs();
    const tolerance = D(config.navTolerancePct);
    return gap.gt(mark.abs().times(tolerance))
      ? finding(
          LT_TIE_01,
          `The exposure at NAV differs from the latest Locked mark by ${gap.toFixed(2)} dollars, beyond ${pct(tolerance)} of the mark`,
          {
            field: 'exposureAtNav',
            expected: mark.toFixed(2),
            actual: provider.toFixed(2),
          },
        )
      : null;
  },
};
const LT_TIE_02: LookthroughRule = {
  id: 'LT-TIE-02',
  category: 'totals_tie',
  severity: 'error',
  title: 'The exposure at cost ties to the invested cost within the tolerance',
  check: ({ row, record, config }) => {
    const provider = decimal(row.exposureAtCost);
    const invested = decimal(record?.exposureAtCost ?? null);
    if (provider === null || invested === null) return null;
    const gap = provider.minus(invested).abs();
    return gap.gt(D(config.costToleranceUsd))
      ? finding(
          LT_TIE_02,
          `The exposure at cost differs from the invested cost by ${gap.toFixed(2)} dollars, beyond the ${D(config.costToleranceUsd).toFixed(2)} dollar tolerance`,
          {
            field: 'exposureAtCost',
            expected: invested.toFixed(2),
            actual: provider.toFixed(2),
          },
        )
      : null;
  },
};

/* ---- Duplicates ---- */
/**
 * What a row is about: the position it links to, else the number or name as written, and the
 * date it reports for; so a row by number and a row by alias for one position are the same row twice.
 */
function duplicateKey(row: LookthroughRow, link: LinkResult): string | null {
  const who =
    link.investment?.id ??
    normalizeName(blank(row.investmentNumber) ? row.companyName : (row.investmentNumber ?? ''));
  if (who === '') return null;
  return `${who}|${row.asOf}`;
}
const LT_DUP_01: LookthroughRule = {
  id: 'LT-DUP-01',
  category: 'duplicates',
  severity: 'error',
  title: 'A position appears once in the extract for a date',
  check: ({ row, link, file }) => {
    const key = duplicateKey(row, link);
    if (key === null) return null;
    const first = file.find((r) => duplicateKey(r.row, r.link) === key);
    return first !== undefined && first.row.rowNo !== row.rowNo
      ? finding(LT_DUP_01, `Row ${first.row.rowNo} already carries this position for ${row.asOf}`, {
          expected: 'one row per position and date',
          actual: `rows ${first.row.rowNo} and ${row.rowNo}`,
        })
      : null;
  },
};

/* ---- Stale ---- */
const LT_STALE_01: LookthroughRule = {
  id: 'LT-STALE-01',
  category: 'stale',
  severity: 'error',
  title: 'The row reports for the run’s as-of date, not an earlier one',
  check: ({ row, asOf }) =>
    isCalendarDate(row.asOf) && isCalendarDate(asOf) && row.asOf < asOf
      ? finding(
          LT_STALE_01,
          `The row reports as of ${row.asOf}, before the run's as-of date ${asOf}: the provider sent an older position`,
          { field: 'asOf', expected: asOf, actual: row.asOf },
        )
      : null,
};

/** Every look-through reconcile rule, in the order findings are reported. */
export const LOOKTHROUGH_RULES: readonly LookthroughRule[] = [
  LT_REQ_01,
  LT_TYPE_01,
  LT_XREF_01,
  LT_XREF_02,
  LT_XREF_03,
  LT_MAP_01,
  LT_MAP_02,
  LT_DIFF_01,
  LT_DIFF_02,
  LT_TIE_01,
  LT_TIE_02,
  LT_DUP_01,
  LT_STALE_01,
];

/** One difference between the provider and the record: what the record says and what the provider sent, as text. */
export interface LookthroughDifference {
  field: LookthroughDifferenceField;
  expected: string | null;
  actual: string | null;
}

/** The rules whose findings are differences: a mapped code or an exposure that does not agree with the record. */
const DIFFERENCE_RULES: ReadonlySet<string> = new Set([
  LT_DIFF_01.id,
  LT_DIFF_02.id,
  LT_TIE_01.id,
  LT_TIE_02.id,
]);

const isDifferenceField = (field: string | null): field is LookthroughDifferenceField =>
  field !== null && (LOOKTHROUGH_FIELDS as readonly string[]).includes(field);

/** The differences a row's findings report, in rule order: the field, the record's text and the provider's. */
export function lookthroughDifferences(findings: readonly Finding[]): LookthroughDifference[] {
  return findings.flatMap((f) =>
    DIFFERENCE_RULES.has(f.ruleId) && isDifferenceField(f.field)
      ? [{ field: f.field, expected: f.expected, actual: f.actual }]
      : [],
  );
}

/** The outcome of checking one provider row before anything is staged. */
export interface PreparedLookthroughRow {
  row: LookthroughRow;
  link: LinkResult;
  mapped: LookthroughMapped;
  record: LookthroughRecord | null;
  findings: Finding[];
  differences: LookthroughDifference[];
  status: 'validated' | 'flagged';
}

/** What is on record, behind one shape: the API's maps or a preview's book. */
export interface LookthroughLookups {
  mapping: LookthroughLabelMapping;
  /** The record for a linked position, or null when the book has nothing for it. */
  recordOf(investmentId: string): LookthroughRecord | null;
}

/** Every linked row of an extract mapped and checked against what is on record for the position it links to. */
export function prepareLookthroughRows(
  file: readonly LookthroughLinkedRow[],
  lookups: LookthroughLookups,
  asOf: string,
  config: LookthroughRuleConfig,
): PreparedLookthroughRow[] {
  return file.map(({ row, link }) => {
    const mapped = mapLabels(lookups.mapping, row);
    const record = link.investment === null ? null : lookups.recordOf(link.investment.id);
    const findings = runRules(LOOKTHROUGH_RULES, {
      row,
      link,
      file,
      mapped,
      record,
      asOf,
      config,
    });
    return {
      row,
      link,
      mapped,
      record,
      findings,
      differences: lookthroughDifferences(findings),
      status: statusFromFindings(findings),
    };
  });
}

/** How urgent an exception is: the exception_severity taxonomy term it is opened with (docs/03). */
export type LookthroughExceptionTier = 'high' | 'medium';

/**
 * A data exception a prepared row opens: one per unresolved link, one per label the mapping does
 * not list and one per difference, each with the texts a person needs to decide. An unresolved
 * link and an exposure that does not tie are high; a label or a code that disagrees is medium.
 * A candidate travels as its reason only, never as a number or a name (SEC-5.3); the candidates
 * themselves stay on the staged row, shown to those who may see them.
 */
export interface LookthroughOpenedException {
  ruleId: string;
  tier: LookthroughExceptionTier;
  expected: string | null;
  actual: string | null;
  candidates: { reason: LinkCandidate['reason'] }[];
}

const LINK_EXCEPTION: Record<Exclude<LinkStatus, 'matched'>, string> = {
  unmatched: LT_XREF_01.id,
  guarded: LT_XREF_02.id,
  ambiguous: LT_XREF_03.id,
};

const EXCEPTION_TIER: Readonly<Record<string, LookthroughExceptionTier>> = {
  [LT_XREF_01.id]: 'high',
  [LT_XREF_02.id]: 'high',
  [LT_XREF_03.id]: 'high',
  [LT_MAP_01.id]: 'medium',
  [LT_MAP_02.id]: 'medium',
  [LT_DIFF_01.id]: 'medium',
  [LT_DIFF_02.id]: 'medium',
  [LT_TIE_01.id]: 'high',
  [LT_TIE_02.id]: 'high',
};

/** The link rule ids: their exception is opened from the link itself, not from the finding. */
const LINK_RULE_IDS: ReadonlySet<string> = new Set(Object.values(LINK_EXCEPTION));

/**
 * The exceptions a prepared row opens: the unresolved link first, then unmapped labels and
 * differences in rule order. A row that names nothing fails LT-REQ-01 and opens no link
 * exception, the same guard as LT-XREF-01: there is nothing to link and nothing to show as actual.
 */
export function lookthroughExceptionsOpenedBy(
  prepared: Pick<PreparedLookthroughRow, 'row' | 'link' | 'findings'>,
): LookthroughOpenedException[] {
  const out: LookthroughOpenedException[] = [];
  if (prepared.link.status !== 'matched' && !nameless(prepared.row)) {
    const ruleId = LINK_EXCEPTION[prepared.link.status];
    const named = blank(prepared.row.investmentNumber)
      ? prepared.row.companyName.trim()
      : (prepared.row.investmentNumber ?? '').trim();
    out.push({
      ruleId,
      tier: 'high',
      expected: 'a position on record',
      actual: named,
      candidates: prepared.link.candidates.map((c) => ({ reason: c.reason })),
    });
  }
  for (const f of prepared.findings) {
    const tier = EXCEPTION_TIER[f.ruleId];
    if (tier === undefined || LINK_RULE_IDS.has(f.ruleId)) continue;
    out.push({ ruleId: f.ruleId, tier, expected: f.expected, actual: f.actual, candidates: [] });
  }
  return out;
}
