import { createContext, useContext, useId, useLayoutEffect } from 'react';

/** What a SharedScale hands its charts: where to report their range, and the range of them all. */
export interface SharedDomain {
  report: (id: string, lo: number, hi: number) => void;
  drop: (id: string) => void;
  domain: readonly [number, number] | null;
}

export const SharedScaleContext = createContext<SharedDomain | null>(null);

/**
 * The value range a chart draws over: its own, widened to every chart's inside a SharedScale.
 * Reported before the browser paints, so a chart is never drawn on its own scale first.
 */
export function useSharedDomain(lo: number, hi: number): readonly [number, number] {
  const shared = useContext(SharedScaleContext);
  const id = useId();
  const report = shared?.report;
  const drop = shared?.drop;
  useLayoutEffect(() => {
    if (report === undefined || drop === undefined) return undefined;
    report(id, lo, hi);
    return () => drop(id);
  }, [report, drop, id, lo, hi]);
  const domain = shared?.domain ?? null;
  if (domain === null) return [lo, hi];
  return [Math.min(lo, domain[0]), Math.max(hi, domain[1])];
}
