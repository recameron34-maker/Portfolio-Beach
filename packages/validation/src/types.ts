/**
 * The shape every intake shares (docs/04 M2): a rule looks at one staged row in its context and
 * reports findings; errors flag the row for a person, warnings travel with it to the reviewer.
 */

export type Severity = 'error' | 'warning';

/** The rule categories docs/04 M2 asks for; every rule id starts with its category's prefix. */
export type RuleCategory =
  | 'required'
  | 'types_units'
  | 'ranges'
  | 'period_continuity'
  | 'period_bounds'
  | 'totals_tie'
  | 'duplicates'
  | 'cross_entity'
  | 'stale';

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** Plain language, written for the reviewer; never the raw row. */
  message: string;
  /** The column the finding is about, when it is about one. */
  field: string | null;
  expected: string | null;
  actual: string | null;
}

export interface Rule<Context> {
  id: string;
  category: RuleCategory;
  severity: Severity;
  /** One line a reviewer reads in the rule list. */
  title: string;
  /** Null when the row passes; a finding (or several) when it does not. */
  check(context: Context): Finding | Finding[] | null;
}

/** Runs every rule and flattens the findings, in rule order. */
export function runRules<Context>(rules: readonly Rule<Context>[], context: Context): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    const result = rule.check(context);
    if (result === null) continue;
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return out;
}

/** The staging status a row lands in from its findings (docs/18 section 2): any error flags it. */
export function statusFromFindings(findings: readonly Finding[]): 'validated' | 'flagged' {
  return findings.some((f) => f.severity === 'error') ? 'flagged' : 'validated';
}

/** A finding builder that keeps every message in the same voice. */
export function finding(
  rule: Pick<Rule<unknown>, 'id' | 'severity'>,
  message: string,
  detail: { field?: string; expected?: string; actual?: string } = {},
): Finding {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    message,
    field: detail.field ?? null,
    expected: detail.expected ?? null,
    actual: detail.actual ?? null,
  };
}
