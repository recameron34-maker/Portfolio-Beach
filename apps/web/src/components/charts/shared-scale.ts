import { createContext, useContext, useId, useLayoutEffect } from 'react';

/** What a SharedScale hands its charts: where to report their range, and the range of them all. */
export interface SharedDomain {
  report: (id: string, lo: number, hi: number, label: number) => void;
  drop: (id: string) => void;
  domain: readonly [number, number] | null;
  /** The widest category label of them all, in estimated pixels; 0 before any chart reported. */
  label: number;
}

export const SharedScaleContext = createContext<SharedDomain | null>(null);

/**
 * The value range a chart draws over, and the widest category label its column must hold: its
 * own, widened to every chart's inside a SharedScale, so equal lengths are equal figures and the
 * plots start on one line. Reported before the browser paints, so a chart is never drawn on its
 * own scale first. `label` is the estimated width of this chart's widest label (0 for none).
 */
export function useSharedDomain(
  lo: number,
  hi: number,
  label = 0,
): readonly [number, number, number] {
  const shared = useContext(SharedScaleContext);
  const id = useId();
  const report = shared?.report;
  const drop = shared?.drop;
  useLayoutEffect(() => {
    if (report === undefined || drop === undefined) return undefined;
    report(id, lo, hi, label);
    return () => drop(id);
  }, [report, drop, id, lo, hi, label]);
  const domain = shared?.domain ?? null;
  if (domain === null) return [lo, hi, label];
  return [Math.min(lo, domain[0]), Math.max(hi, domain[1]), Math.max(label, shared?.label ?? 0)];
}
