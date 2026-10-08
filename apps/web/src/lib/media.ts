import { useSyncExternalStore } from 'react';

/** The stylesheet's phone breakpoint (styles.css, max-width: 760px). */
const NARROW = '(max-width: 760px)';

const query = (): MediaQueryList | null =>
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(NARROW) : null;

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/** True on a phone-width screen; false where matchMedia is missing (tests), so desktop is the default. */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? false,
    () => false,
  );
}
