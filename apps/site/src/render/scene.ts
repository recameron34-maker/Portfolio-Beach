import { html } from './html.js';
import type { Markup } from './html.js';

/**
 * The beach: the sign-in scene of the tool (apps/web/src/components/BeachBackground.tsx), given
 * more room. Each edge is one curve with four periods across 1600 units, so the tangent at 0, 800
 * and 1600 is the same and a layer twice as wide as the page, moved by half its width, lands on
 * its own second half: the drift has no seam. Colours come from the stylesheet only.
 */
const SWELL =
  'M0 40 C50 30 150 30 200 40 S350 50 400 40 S550 30 600 40 S750 50 800 40 S950 30 1000 40 S1150 50 1200 40 S1350 30 1400 40 S1550 50 1600 40 V160 H0 Z';
const SHORE_EDGE =
  'M0 20 C50 12 150 12 200 20 S350 28 400 20 S550 12 600 20 S750 28 800 20 S950 12 1000 20 S1150 28 1200 20 S1350 12 1400 20 S1550 28 1600 20';
const SHORE = `${SHORE_EDGE} V64 H0 Z`;

/** One gentle crest, the divider between two bands of the page. */
const CREST = 'M0 30 C180 6 380 4 600 24 S1010 52 1220 30 S1500 8 1600 22 V56 H0 Z';

function swell(name: string): Markup {
  return html`<svg
    class="scene-swell scene-swell-${name}"
    viewBox="0 0 1600 160"
    preserveAspectRatio="none"
    focusable="false"
  >
    <path d="${SWELL}" />
  </svg>`;
}

/** The scene behind the hero. Decorative: hidden from assistive technology, ignores the pointer. */
export function scene(): Markup {
  return html`<div class="scene" aria-hidden="true">
    <div class="scene-sky"></div>
    <div class="scene-glow"></div>
    <div class="scene-sun"></div>
    <div class="scene-sea"></div>
    <div class="scene-glint"></div>
    ${swell('a')} ${swell('b')} ${swell('c')}
    <div class="scene-shore">
      <svg class="scene-wash" viewBox="0 0 1600 64" preserveAspectRatio="none" focusable="false">
        <path d="${SHORE}" />
      </svg>
      <svg class="scene-sand" viewBox="0 0 1600 64" preserveAspectRatio="none" focusable="false">
        <path class="scene-sand-fill" d="${SHORE}" />
        <path class="scene-foam" d="${SHORE_EDGE}" />
      </svg>
    </div>
    <div class="scene-beach"></div>
    <div class="scene-horizon"></div>
  </div>`;
}

/** The crest that lifts a band of the page into the one above it. It takes the band's own colour. */
export function crest(): Markup {
  return html`<svg
    class="crest"
    viewBox="0 0 1600 56"
    preserveAspectRatio="none"
    aria-hidden="true"
    focusable="false"
  >
    <path d="${CREST}" />
  </svg>`;
}

/** A short wave drawn under a heading's eyebrow, the site's one recurring mark. */
export function ripple(): Markup {
  return html`<svg
    class="ripple"
    viewBox="0 0 64 8"
    width="64"
    height="8"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M1 4 C6 0.5 11 0.5 16 4 S26 7.5 32 4 S42 0.5 48 4 S58 7.5 63 4" />
  </svg>`;
}
