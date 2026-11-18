import { useCallback, useState, useSyncExternalStore } from 'react';
import type { AnimationEvent } from 'react';

/*
 * The motion language for script (docs/06 section 5, decision 0026). styles.css holds the same
 * values as custom properties (--pb-dur-*, --pb-stagger, --pb-rise, --pb-ease*); motion.test.ts
 * fails if the two disagree. Motion is decoration: it confirms that something arrived or that the
 * reader's own action landed, never carries meaning alone, and stops under the reduced-motion
 * setting or on a slow display.
 */

/** Durations in milliseconds, and the stagger step and rise distance in pixels. */
export const MOTION = {
  /** A press, a tooltip. */
  instant: 80,
  /** Colour, border, a chevron turning, every exit. */
  fast: 120,
  /** Small entrances, a status line. */
  base: 180,
  /** A page, section or dialog arriving. */
  enter: 220,
  /** A bar growing, a step filling, the radar opening. */
  slow: 320,
  /** A line or sparkline drawing. */
  draw: 480,
  /** Between siblings that arrive in turn. */
  stagger: 24,
  /** How far an entrance travels, in pixels. */
  rise: 4,
} as const;

/** The three curves: decelerate for entrances and hovers, symmetric for drawing, accelerate for exits. */
export const EASE = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  inout: 'cubic-bezier(0.45, 0, 0.55, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

/** The reader asked for less motion, or the display cannot show it smoothly. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce), (update: slow)';

const query = (): MediaQueryList | null =>
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(REDUCED_MOTION_QUERY) : null;

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/**
 * True when motion should stop. Where the browser cannot say (no matchMedia, as in tests), the
 * answer is yes, so nothing animates that cannot be switched off.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? true,
    () => true,
  );
}

/** What a Fluent Dialog's surfaceMotion slot takes: its Scale presence parameters. */
export interface DialogSurfaceMotion {
  outScale: number;
  duration: number;
  easing: string;
  exitDuration: number;
  exitEasing: string;
}

/**
 * A dialog arrives from 98% and fades in, and leaves faster than it came; with reduced motion it
 * appears and goes at once (Fluent checks only prefers-reduced-motion, this covers a slow display).
 */
export function dialogSurfaceMotion(reduced: boolean): DialogSurfaceMotion {
  return {
    outScale: 0.98,
    duration: reduced ? 0 : 200,
    easing: EASE.standard,
    exitDuration: reduced ? 0 : MOTION.fast,
    exitEasing: EASE.exit,
  };
}

/** The props a row takes while it washes: the attribute styles.css animates, and its clearing. */
export interface JustChangedProps {
  'data-just-changed'?: true;
  onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * The row the reader's own command just changed washes once (styles.css,
 * `.pb-table tr[data-just-changed]`). Call `mark` in the mutation's onSuccess, never on a refetch,
 * and spread `rowProps(key)` on each row. The attribute clears when the wash ends, so the next
 * command on the same row washes it again. Nothing is marked under reduced motion.
 */
export function useJustChanged(): {
  mark: (key: string) => void;
  rowProps: (key: string) => JustChangedProps;
} {
  const reduced = useReducedMotion();
  const [changed, setChanged] = useState<string | null>(null);
  const mark = useCallback(
    (key: string) => {
      if (!reduced) setChanged(key);
    },
    [reduced],
  );
  const rowProps = useCallback(
    (key: string): JustChangedProps =>
      key === changed
        ? {
            'data-just-changed': true,
            onAnimationEnd: (event) => {
              if (event.animationName === 'pb-wash') setChanged(null);
            },
          }
        : {},
    [changed],
  );
  return { mark, rowProps };
}
