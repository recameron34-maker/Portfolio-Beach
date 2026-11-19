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
 * The steps of a workflow as one row of segments: the deal stages of the pipeline, the release gate
 * of a reporting package. Only the current step and the ones done are named (docs/06 section 6); a
 * step still ahead says so to a screen reader alone. The strip counts its steps for the stylesheet,
 * and numbers each one so the segments done fill in order. On a narrow phone the names give way to
 * one line under the row ("Step 5 of 8: IC"), hidden from screen readers, which read the list.
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
  const at = steps.findIndex((step) => step.status === 'current');
  return (
    <>
      <ol
        className="pb-steps"
        aria-label={label}
        style={{ '--pb-steps': steps.length } as CSSProperties}
        data-testid={testId}
      >
        {steps.map((step, index) => (
          <li
            key={step.key}
            data-status={step.status}
            style={{ '--i': index } as CSSProperties}
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
      {at < 0 ? null : (
        <p className="pb-steps-summary" aria-hidden="true">
          Step {at + 1} of {steps.length}: {steps[at]?.label}
        </p>
      )}
    </>
  );
}
