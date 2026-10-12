import { D } from '@pb/calc';
import type { AccountingRow } from './layout.js';

/** The approved quarter the row would replace, as the database holds it. */
export interface CurrentQuarter {
  periodEnd: string;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
}

export const DIFF_FIELDS = ['revenueLtm', 'ebitdaLtm', 'ev', 'netDebt'] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

export interface FieldChange {
  field: DiffField;
  before: string | null;
  after: string | null;
}

export interface RowDiff {
  kind: 'new' | 'changed' | 'unchanged';
  changes: FieldChange[];
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Equal as decimals when both parse; otherwise equal as trimmed text. */
export function sameValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = a.trim();
  const y = b.trim();
  if (DECIMAL.test(x) && DECIMAL.test(y)) return D(x).eq(D(y));
  return x === y;
}

/**
 * What the row would change against the approved quarter: nothing (unchanged), a field or more
 * (changed), or everything because no quarter is on record (new). The fair value is not part of
 * the diff: it ties to the Locked mark instead (TIE-01), it is never written from a file.
 */
export function diffRow(row: AccountingRow, current: CurrentQuarter | null): RowDiff {
  if (current === null) {
    return {
      kind: 'new',
      changes: DIFF_FIELDS.map((field) => ({ field, before: null, after: row.figures[field] })),
    };
  }
  const changes: FieldChange[] = [];
  for (const field of DIFF_FIELDS) {
    const after = row.figures[field];
    const before = current[field];
    if (!sameValue(before, after)) changes.push({ field, before, after });
  }
  return { kind: changes.length === 0 ? 'unchanged' : 'changed', changes };
}
