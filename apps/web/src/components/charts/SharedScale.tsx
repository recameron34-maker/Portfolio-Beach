import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { SharedScaleContext } from './shared-scale.js';

/** What one chart reported: the range of its marks and the width its widest label needs. */
type Extent = readonly [lo: number, hi: number, label: number];

/**
 * Charts set side by side to be compared (NAV and invested by sector, contributions and
 * distributions by year) read one value axis: each child chart reports the range of its own
 * marks and the width of its widest category label (useSharedDomain), and every one draws over
 * the range that covers them all, from a plot that starts after the widest label of them all, so
 * equal lengths are equal figures. Geometry only: no figure is worked out here, and each chart's
 * printed values, tooltip and table are its own.
 */
export function SharedScale({ children }: { children: ReactNode }): ReactNode {
  const [extents, setExtents] = useState<ReadonlyMap<string, Extent>>(() => new Map());
  const report = useCallback((id: string, lo: number, hi: number, label: number) => {
    setExtents((prev) => {
      const had = prev.get(id);
      if (had?.[0] === lo && had[1] === hi && had[2] === label) return prev;
      const next = new Map(prev);
      next.set(id, [lo, hi, label]);
      return next;
    });
  }, []);
  const drop = useCallback((id: string) => {
    setExtents((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const shared = useMemo((): { domain: readonly [number, number] | null; label: number } => {
    if (extents.size === 0) return { domain: null, label: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    let label = 0;
    for (const [a, b, c] of extents.values()) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
      label = Math.max(label, c);
    }
    return { domain: [lo, hi], label };
  }, [extents]);
  const value = useMemo(() => ({ report, drop, ...shared }), [report, drop, shared]);
  return <SharedScaleContext.Provider value={value}>{children}</SharedScaleContext.Provider>;
}
