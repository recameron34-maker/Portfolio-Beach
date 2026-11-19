import { useCallback, useState } from 'react';
import type { RefCallback } from 'react';

/**
 * Measured width of a chart canvas so SVG charts render at real pixel size. The ref is a callback
 * that observes whichever element is mounted, so a canvas that remounts (after "Show table" and
 * "Show chart") is measured again; the fallback stands in where ResizeObserver is absent.
 * `measured` turns true with the first real measurement and stays true, so a chart's entrance
 * waits for its real width and never plays at the fallback first.
 */
export function useWidth(fallback = 640): [RefCallback<HTMLDivElement>, number, boolean] {
  const [state, setState] = useState({ width: fallback, measured: false });
  const ref = useCallback<RefCallback<HTMLDivElement>>((el) => {
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) {
        const width = Math.floor(w);
        setState((s) => (s.width === width && s.measured ? s : { width, measured: true }));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, state.width, state.measured];
}
