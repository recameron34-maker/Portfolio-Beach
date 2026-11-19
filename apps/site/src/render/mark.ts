import { trusted } from './html.js';
import type { Markup } from './html.js';

/**
 * The product's mark, as the tool draws it (apps/web/src/components/Wordmark.tsx, docs/06
 * section 2): a small ink square holding three bars of falling length, read as an allocation. On
 * a 16 unit grid. The page colours it from its stylesheet (.mark-tile, .mark-bar); the browser-tab
 * icon passes its colours, since it has no stylesheet.
 */
const BARS = [
  { y: 3.5, width: 10 },
  { y: 7, width: 7 },
  { y: 10.5, width: 4 },
];

/** The mark's shapes, coloured by class, or by the fills given. */
export function markShapes(fill?: { tile: string; bar: string }): string {
  const tile = fill === undefined ? 'class="mark-tile"' : `fill="${fill.tile}"`;
  const bar = fill === undefined ? 'class="mark-bar"' : `fill="${fill.bar}"`;
  return [
    `<rect ${tile} width="16" height="16" rx="2"/>`,
    ...BARS.map((b) => `<rect ${bar} x="3" y="${b.y}" width="${b.width}" height="2"/>`),
  ].join('');
}

/** The mark beside the product's name. Decorative: the name beside it is what a reader hears. */
export function mark(size = 18): Markup {
  return trusted(
    `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${markShapes()}</svg>`,
  );
}
