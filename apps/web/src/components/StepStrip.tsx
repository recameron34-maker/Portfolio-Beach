import type { CSSProperties, ReactNode } from 'react';

/** Where a step stands against the record: behind it, on it or still ahead. */
export type StepStatus = 'done' | 'current' | 'upcoming';

export interface Step {
  /** What tells the steps of one strip apart; never shown. */
  key: string;
  /** The step's name as the reader sees it. */
  label: string;
  status: StepStatus;
}

/**
 * The steps of a workflow as an ordered strip that wraps: the deal stages of the pipeline, the
 * release gate of a reporting package. Only the current step and the ones done are named
 * (docs/06 section 6); a step still ahead says so to a screen reader alone. The strip counts its
 * steps for the stylesheet, which lays them out in one row, then two, then in pairs.
 */
export function StepStrip({
  label,
  steps,
  testId,
}: {
  /** What the strip is, for a screen reader ("Deal stages"). */
  label: string;
  steps: readonly Step[];
  testId?: string | undefined;
}): ReactNode {
  const counts = {
    '--pb-steps': steps.length,
    '--pb-steps-half': Math.max(1, Math.ceil(steps.length / 2)),
  } as CSSProperties;
  return (
    <ol className="pb-steps" aria-label={label} style={counts} data-testid={testId}>
      {steps.map((step) => (
        <li
          key={step.key}
          data-status={step.status}
          {...(step.status === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span>{step.label}</span>
          {step.status === 'done' ? (
            <span className="pb-step-state">
              <span aria-hidden="true">{'✓'}</span> Done
            </span>
          ) : step.status === 'current' ? (
            <span className="pb-step-state">Current</span>
          ) : (
            <span className="pb-visually-hidden">Upcoming</span>
          )}
        </li>
      ))}
    </ol>
  );
}
