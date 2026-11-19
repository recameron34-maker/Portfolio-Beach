import type { ReactNode } from 'react';

/**
 * The product's mark and name (docs/06 section 2, decision 0026): a small ink square holding three
 * bars of falling length, read as an allocation, then "Portfolio Beach". The colours come from
 * styles.css (.pb-wordmark-mark); the mark is decoration, so the name is what a reader hears.
 */
export function Wordmark({ size = 16 }: { size?: number }): ReactNode {
  return (
    <span className="pb-wordmark-lockup">
      <svg
        className="pb-wordmark-mark"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <rect className="pb-wordmark-tile" width="16" height="16" rx="2" />
        <rect className="pb-wordmark-bar" x="3" y="3.5" width="10" height="2" />
        <rect className="pb-wordmark-bar" x="3" y="7" width="7" height="2" />
        <rect className="pb-wordmark-bar" x="3" y="10.5" width="4" height="2" />
      </svg>
      <span className="pb-wordmark-name">Portfolio Beach</span>
    </span>
  );
}
