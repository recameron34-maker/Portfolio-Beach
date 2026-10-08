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

/** Shortens a category label for an axis; the full label stays in the tooltip and the table. */
export function truncateLabel(label: string, max = 22): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}...`;
}

/** Series color token by slot (1-based); slots past the palette fold into the last one on purpose. */
export function seriesColor(slot: number): string {
  return `var(--pb-chart-${Math.min(Math.max(slot, 1), 8)})`;
}
