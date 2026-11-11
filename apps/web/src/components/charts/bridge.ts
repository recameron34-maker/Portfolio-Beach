/** Geometry of a bridge (waterfall) chart, apart from the component so it can be tested on its own. */

export interface BridgeStep {
  label: string;
  /** A level for a total, a signed change for a step: geometry only, the label is `display`. */
  value: number;
  display: string;
  /** total: a bar from zero to the level; change: a bar from the running level to the next. */
  kind: 'total' | 'change';
}

/** Where each step's bar runs from and to on the value axis: totals from zero, changes from the running level. */
export function bridgeSpans(steps: readonly BridgeStep[]): { from: number; to: number }[] {
  let level = 0;
  return steps.map((step) => {
    if (step.kind === 'total') {
      level = step.value;
      return { from: 0, to: step.value };
    }
    const from = level;
    level += step.value;
    return { from, to: level };
  });
}
