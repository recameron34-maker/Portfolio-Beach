import type { ReactNode } from 'react';

/**
 * Animated beach for the sign-in page. Decorative only (aria-hidden, pointer-events none).
 * Each wave is one edge with four periods across 1600 units, so the tangent at 0, 800 and 1600 is identical
 * and a 200%-wide layer translated by -50% lands on its own second half: the loop has no seam.
 * All colours come from styles.css (currentColor and gradients over --pb-* variables).
 */
const SWELL =
  'M0 40 C50 30 150 30 200 40 S350 50 400 40 S550 30 600 40 S750 50 800 40 S950 30 1000 40 S1150 50 1200 40 S1350 30 1400 40 S1550 50 1600 40 V160 H0 Z';
const FOAM =
  'M0 20 C50 12 150 12 200 20 S350 28 400 20 S550 12 600 20 S750 28 800 20 S950 12 1000 20 S1150 28 1200 20 S1350 12 1400 20 S1550 28 1600 20';

export function BeachBackground(): ReactNode {
  return (
    <div className="pb-scene" aria-hidden="true">
      <div className="pb-scene-sky" />
      <div className="pb-scene-sea" />
      <div className="pb-scene-glow" />
      <svg
        className="pb-scene-wave pb-scene-wave-a"
        viewBox="0 0 1600 160"
        preserveAspectRatio="none"
        focusable="false"
      >
        <path d={SWELL} />
      </svg>
      <svg
        className="pb-scene-wave pb-scene-wave-b"
        viewBox="0 0 1600 160"
        preserveAspectRatio="none"
        focusable="false"
      >
        <path d={SWELL} />
      </svg>
      <div className="pb-scene-sand" />
      <div className="pb-scene-tide">
        <svg
          className="pb-scene-foam"
          viewBox="0 0 1600 40"
          preserveAspectRatio="none"
          focusable="false"
        >
          <path d={FOAM} />
        </svg>
      </div>
      <div className="pb-scene-horizon" />
    </div>
  );
}
