import { useCallback, useEffect, useRef, useState } from 'react';
import { WORLD_VIEW, clampView, tweenView } from './map-model.js';
import type { View } from './map-model.js';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader asked for less motion. Where the browser cannot say (no matchMedia), the
 * answer is yes: the map then moves at once, with nothing animated.
 */
export function usePrefersReducedMotion(): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [reduced, setReduced] = useState(() => !supported || window.matchMedia(QUERY).matches);
  useEffect(() => {
    if (!supported) return;
    const media = window.matchMedia(QUERY);
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [supported]);
  return reduced;
}

/** Slow at both ends, quick in the middle: how a flight between two views is paced. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export interface MapView {
  view: View;
  /** Moves to a view over a moment; at once when motion is reduced. */
  flyTo: (target: View, milliseconds?: number) => void;
  /** Moves to a view at once (dragging, the keyboard). */
  jumpTo: (target: View) => void;
  /** The view the map is at or is flying to. */
  target: () => View;
}

/** The map's view, and the flight from one view to another, one animation frame at a time. */
export function useMapView(reduced: boolean): MapView {
  const [view, setView] = useState<View>(WORLD_VIEW);
  const current = useRef(view);
  const heading = useRef(view);
  const frame = useRef<number | null>(null);

  const stop = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const show = useCallback((next: View): void => {
    current.current = next;
    setView(next);
  }, []);

  const jumpTo = useCallback(
    (next: View): void => {
      stop();
      heading.current = clampView(next);
      show(heading.current);
    },
    [show, stop],
  );

  const flyTo = useCallback(
    (next: View, milliseconds = 700): void => {
      stop();
      const to = clampView(next);
      heading.current = to;
      if (reduced || milliseconds <= 0 || typeof requestAnimationFrame !== 'function') {
        show(to);
        return;
      }
      const from = current.current;
      let started: number | null = null;
      const step = (now: number): void => {
        started ??= now;
        const t = Math.min((now - started) / milliseconds, 1);
        show(tweenView(from, to, easeInOut(t)));
        frame.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [reduced, show, stop],
  );

  useEffect(() => stop, [stop]);

  const target = useCallback((): View => heading.current, []);
  return { view, flyTo, jumpTo, target };
}
