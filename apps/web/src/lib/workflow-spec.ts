import type { Machine, Transition, TransitionContext } from '@pb/workflows';
import { commandLabel, humanizeState, rolesLabel } from './states.js';

/* The rows of a workflow specification card (components/WorkflowSpec.tsx), from a transition table. */

/** Nothing done yet: run against this, a step's precondition answers with its rule in the code's own words. */
const NOTHING_DONE: TransitionContext = { actorId: '', actorRoles: [], record: {} };

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const sentence = (text: string): string => {
  const capital = capitalize(text);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

type Check = NonNullable<Transition<string, string>['precondition']>;

/** A precondition's checks: the list an all() keeps, or the precondition itself. */
const checksOf = (precondition: Check | undefined): readonly Check[] =>
  precondition === undefined
    ? []
    : ((precondition as { checks?: readonly Check[] }).checks ?? [precondition]);

/** Every rule a step checks, then its note, as sentences; null when the step has neither. */
export function ruleOf(step: Transition<string, string>): string | null {
  const parts = [...checksOf(step.precondition).map((c) => c(NOTHING_DONE)), step.note ?? null];
  const text = parts.filter((p): p is string => p !== null);
  return text.length === 0 ? null : text.map(sentence).join(' ');
}

export interface StepRow {
  from: string[];
  step: string;
  to: string;
  who: string;
  rule: string | null;
}

/** One row per distinct step, its starting states joined, so seven "pass" steps read as one. */
export function stepRows(machine: Machine<string, string>): StepRow[] {
  const rows: StepRow[] = [];
  for (const t of machine.transitions) {
    const row = {
      from: [humanizeState(t.from)],
      step: commandLabel(t.command),
      to: humanizeState(t.to),
      who: capitalize(rolesLabel(t.roles)),
      rule: ruleOf(t),
    };
    const same = rows.find(
      (r) => r.step === row.step && r.to === row.to && r.who === row.who && r.rule === row.rule,
    );
    if (same === undefined) rows.push(row);
    else same.from.push(...row.from);
  }
  return rows;
}
