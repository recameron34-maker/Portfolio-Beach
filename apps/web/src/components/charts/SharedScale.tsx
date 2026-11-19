import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { SharedScaleContext } from './shared-scale.js';

/**
 * Charts set side by side to be compared (NAV and invested by sector, contributions and
 * distributions by year) read one value axis: each child chart reports the range of its own
 * marks (useSharedDomain) and every one draws over the range that covers them all, so equal
 * lengths are equal figures. Geometry only: no figure is worked out here, and each chart's
 * printed values, tooltip and table are its own.
 */
export function SharedScale({ children }: { children: ReactNode }): ReactNode {
  const [extents, setExtents] = useState<ReadonlyMap<string, readonly [number, number]>>(
    () => new Map(),
  );
  const report = useCallback((id: string, lo: number, hi: number) => {
    setExtents((prev) => {
      const had = prev.get(id);
      if (had?.[0] === lo && had[1] === hi) return prev;
      const next = new Map(prev);
      next.set(id, [lo, hi]);
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
  const domain = useMemo((): readonly [number, number] | null => {
    if (extents.size === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [a, b] of extents.values()) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    return [lo, hi];
  }, [extents]);
  const value = useMemo(() => ({ report, drop, domain }), [report, drop, domain]);
  return <SharedScaleContext.Provider value={value}>{children}</SharedScaleContext.Provider>;
}
