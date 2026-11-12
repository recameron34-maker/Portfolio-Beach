import { useCallback, useState } from 'react';
import type { RefCallback } from 'react';

/**
 * Measured width of a chart canvas so SVG charts render at real pixel size. The ref is a callback
 * that observes whichever element is mounted, so a canvas that remounts (after "Show table" and
 * "Show chart") is measured again; the fallback stands in where ResizeObserver is absent.
 */
export function useWidth(fallback = 640): [RefCallback<HTMLDivElement>, number] {
  const [width, setWidth] = useState(fallback);
  const ref = useCallback<RefCallback<HTMLDivElement>>((el) => {
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(Math.floor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
