/** Scale and tick helpers for the hand-written SVG charts (no chart library, docs/13). */

export type ValueKind = 'money' | 'pct' | 'multiple' | 'count';

function roundTo(value: number, step: number): number {
  const places = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(places));
}

/** A "nice" tick step (1, 2, 5 times a power of ten) for roughly `count` ticks over `span`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const rough = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * pow;
}

/** Tick values covering [min, max] (and zero when asked), on nice steps. */
export function niceTicks(min: number, max: number, count = 5, includeZero = true): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  let lo = includeZero ? Math.min(min, 0) : min;
  let hi = includeZero ? Math.max(max, 0) : max;
  if (lo === hi) {
    if (lo === 0) return [0, 1];
    lo = lo > 0 ? 0 : lo * 1.1;
    hi = hi > 0 ? hi * 1.1 : 0;
  }
  const step = niceStep(hi - lo, count);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(roundTo(v, step));
  return ticks;
}

/**
 * Every how many ticks a label fits: gridlines stay on every tick, labels keep at least
 * minLabelPx between them so compact values such as "$100M" never collide in a narrow card.
 */
export function labelStride(intervals: number, spanPx: number, minLabelPx = 56): number {
  if (intervals <= 0 || !(spanPx > 0)) return 1;
  return Math.max(1, Math.ceil(minLabelPx / (spanPx / intervals)));
}

/** Linear map from [d0, d1] to [r0, r1]. */
export function linearScale(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (value: number) => number {
  const span = d1 - d0 === 0 ? 1 : d1 - d0;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Short axis labels: $12M, $850K, 12%, 1.5x, 1,200. Full values belong in tooltips and tables. */
export function compactValue(value: number, kind: ValueKind): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  switch (kind) {
    case 'money': {
      if (abs >= 1_000_000) {
        const m = abs / 1_000_000;
        return `${sign}$${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
      }
      if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
      return `${sign}$${abs.toFixed(0)}`;
    }
    case 'pct': {
      const p = abs * 100;
      return `${sign}${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
    }
    case 'multiple':
      return `${sign}${abs.toFixed(1)}x`;
    case 'count':
      return `${sign}${abs.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
}

/** Average advance of one character of a 12 px category label: an estimate for fitting, not a measurement. */
export const LABEL_CHAR_PX = 6.6;
/** Space between the end of a category label and the plot. */
export const LABEL_GAP = 10;

/**
 * Width of the category label column of a bar chart: about 36 percent of the chart, never under
 * 96 or over 220 pixels, so the bars keep most of a phone-width card.
 */
export function labelColumn(width: number): number {
  return Math.round(Math.min(220, Math.max(96, width * 0.36)));
}

/** How many characters of a category label fit in a label column (4 px kept clear on the left). */
export function labelBudget(column: number): number {
  return Math.max(5, Math.floor((column - LABEL_GAP - 4) / LABEL_CHAR_PX));
}

const ELLIPSIS = '...';

/**
 * Shortens a category label to at most max characters by cutting the middle, so labels that share
 * a long start ("Beach Co-Invest Fund II", "Beach Co-Invest Fund III") keep the ends that tell
 * them apart. The kept end starts on a word when a word boundary is close. The full label stays
 * in the tooltip, the aria-label and the table twin.
 */
export function truncateMiddle(label: string, max: number): string {
  if (label.length <= max) return label;
  const room = max - ELLIPSIS.length;
  // Too narrow for a start, an ellipsis and an end: the end is what tells similar labels apart.
  if (room < 2) return label.slice(label.length - Math.max(0, max));
  let tailStart = label.length - Math.ceil(room / 2);
  const wordStart = label.lastIndexOf(' ', tailStart - 1) + 1;
  if (wordStart > 0 && wordStart < tailStart) {
    // Inside a word: take the whole word when only a letter or two is missing and one character
    // of the start still fits; otherwise start the end part at the next word.
    const next = label.indexOf(' ', tailStart);
    if (tailStart - wordStart <= 2 && label.length - wordStart <= room - 1) tailStart = wordStart;
    else if (next !== -1 && label.length - (next + 1) >= 2) tailStart = next + 1;
  }
  const tail = label.slice(tailStart).trimStart();
  return `${label.slice(0, room - tail.length).trimEnd()}${ELLIPSIS}${tail}`;
}

/**
 * Where a bar's value label goes: just past the bar's end, but never past the right edge of the
 * chart; when it would be, it is anchored at the edge instead and reads back from it.
 */
export function valueLabelPosition(
  end: number,
  width: number,
): { x: number; anchor: 'start' | 'end' } {
  const x = Math.min(end + 6, width - 4);
  return { x, anchor: x < end + 6 ? 'end' : 'start' };
}

/** Series color token by slot (1-based); slots past the palette fold into the last one on purpose. */
export function seriesColor(slot: number): string {
  return `var(--pb-chart-${Math.min(Math.max(slot, 1), 8)})`;
}
