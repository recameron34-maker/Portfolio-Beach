import { groupThousands } from '../../lib/format.js';

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
      return `${sign}${groupThousands(abs.toFixed(0))}`;
  }
}

/**
 * The figures under an axis's gridlines, written alike: one unit for the whole axis ($M, $K or $,
 * by its largest tick) and as many decimals as the step between ticks needs, so no two ticks read
 * the same and none carries a decimal its neighbours lack ("5%, 10%, 15%"; "$18.0M, $18.2M").
 * Zero is written plainly. Full figures belong in tooltips and tables.
 */
export function axisLabels(ticks: readonly number[], kind: ValueKind): string[] {
  const step = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) : 0;
  const top = Math.max(0, ...ticks.map((t) => Math.abs(t)));
  const places = (unit: number, least = 0): number =>
    step > 0 ? Math.max(least, Math.min(3, Math.ceil(-Math.log10(step / unit) - 1e-9))) : least;
  const [unit, suffix]: [number, string] =
    top >= 1_000_000 ? [1_000_000, 'M'] : top >= 1_000 ? [1_000, 'K'] : [1, ''];
  return ticks.map((t) => {
    const sign = t < 0 ? '-' : '';
    const abs = Math.abs(t);
    switch (kind) {
      case 'money':
        return abs === 0 ? '$0' : `${sign}$${(abs / unit).toFixed(places(unit))}${suffix}`;
      case 'pct':
        return abs === 0 ? '0%' : `${sign}${(abs * 100).toFixed(places(0.01))}%`;
      case 'multiple':
        return `${sign}${abs.toFixed(places(1, 1))}x`;
      case 'count':
        return abs === 0 ? '0' : `${sign}${groupThousands(abs.toFixed(places(1)))}`;
    }
  });
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

/** Where a bar chart sets its category labels: beside the bars, or each on its own line above its bar. */
export type LabelLayout = 'side' | 'above';

/** Under this chart width the labels go above their bars, whole, instead of being cut to fit beside them. */
export const LABELS_ABOVE_UNDER = 480;

/**
 * The label layout for a chart this wide: beside the bars from 480px; under it, above them unless
 * every label (when given) fits its column whole, so a label is never cut on a phone and short
 * ones (years) keep the compact rows.
 */
export function labelLayout(width: number, labels?: readonly string[]): LabelLayout {
  if (width >= LABELS_ABOVE_UNDER) return 'side';
  if (labels === undefined) return 'above';
  const budget = labelBudget(labelColumn(width));
  return labels.every((label) => label.length <= budget) ? 'side' : 'above';
}

/** Thickness of a bar, in pixels, at every width. */
export const BAR = 12;

/** The rows of a bar chart for a canvas of a given width (HorizontalBars, StackedBars, BridgeChart). */
export interface BarRows {
  layout: LabelLayout;
  /** Height of one category's row. */
  row: number;
  /** Where the plot starts: after the label column beside the bars, at the left edge above them. */
  plotLeft: number;
  /** The label column's width; 0 when the labels sit above the bars. */
  labelWidth: number;
  /** From the top of a row to the top of its bar. */
  barTop: number;
  /** From the top of a row to the baseline of its label. */
  labelBaseline: number;
  /** Where each label starts or ends, and from which side. */
  labelX: number;
  labelAnchor: 'start' | 'end';
}

/** Beside the bars: 26px rows with the label centred on its bar. Above them: 40px rows, the label's line then its bar. */
export function barRows(width: number, labels?: readonly string[]): BarRows {
  if (labelLayout(width, labels) === 'above') {
    return {
      layout: 'above',
      row: 40,
      plotLeft: 0,
      labelWidth: 0,
      barTop: 20,
      labelBaseline: 13,
      labelX: 0,
      labelAnchor: 'start',
    };
  }
  const row = 26;
  const labelWidth = labelColumn(width);
  return {
    layout: 'side',
    row,
    plotLeft: labelWidth,
    labelWidth,
    barTop: (row - BAR) / 2,
    labelBaseline: (row - BAR) / 2 + BAR / 2 + 4,
    labelX: labelWidth - LABEL_GAP,
    labelAnchor: 'end',
  };
}

/**
 * A tick's figure is centred under its gridline, except at the plot's left edge, where it would
 * be cut: there it starts on the line instead.
 */
export function tickAnchor(x: number, minX = 16): 'start' | 'middle' {
  return x < minX ? 'start' : 'middle';
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

/** Keeps the start of a label and cuts its end, for labels that differ only in the middle. */
function truncateEnd(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
}

/**
 * The category labels of one chart, each at most max characters and, where the room allows, no
 * two alike. Labels are cut in the middle (truncateMiddle); labels whose cuts come out the same
 * because they differ only in the middle ("Seagrass Fund II", "Seagrass Growth Fund II") keep
 * their start instead, where they differ. Same order as the input.
 */
export function chartLabels(labels: readonly string[], max: number): string[] {
  const cuts = labels.map((label) => truncateMiddle(label, max));
  const groups = new Map<string, Set<string>>();
  cuts.forEach((cut, i) => {
    const group = groups.get(cut) ?? new Set<string>();
    group.add(labels[i] ?? '');
    groups.set(cut, group);
  });
  const starts = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const kept = [...group].map((label) => truncateEnd(label, max));
    // Only when the starts tell every label of the group apart; otherwise the ends stay.
    if (new Set(kept).size === group.size) {
      [...group].forEach((label, i) => starts.set(label, kept[i] ?? label));
    }
  }
  return labels.map((label, i) => starts.get(label) ?? cuts[i] ?? label);
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

export interface RunPoint {
  i: number;
  v: number;
}

/**
 * Runs of consecutive known values. A missing value ends a run, so it shows as a gap in the line
 * and never as a line drawn through a figure that does not exist (CLAUDE.md rule 10).
 *
 * `absent` marks the points a series does not have by design: a date that belongs to another
 * series of the same chart, where this one was never measured. Nothing is missing there, so the
 * run carries on to the series' next value.
 */
export function knownRuns(
  values: readonly (number | null)[],
  absent?: readonly boolean[],
): RunPoint[][] {
  const out: RunPoint[][] = [];
  let run: RunPoint[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (absent?.[i] === true) return;
      if (run.length > 0) out.push(run);
      run = [];
    } else run.push({ i, v });
  });
  if (run.length > 0) out.push(run);
  return out;
}

/** A line chart's end labels keep at least this far apart; one moved off its line gets a leader. */
export const LABEL_STEP = 14;

/**
 * End labels moved apart: in order from the top, each at least LABEL_STEP below the one before;
 * then, from the foot, none below `bottom` and each at least LABEL_STEP above the next; none
 * above `top`. `at` stays where its line ends, for the leader.
 */
export function dodge<T extends { y: number; at: number }>(
  sorted: readonly T[],
  top: number,
  bottom: number,
): T[] {
  const out = sorted.map((c) => ({ ...c }));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev !== undefined && cur !== undefined) cur.y = Math.max(cur.y, prev.y + LABEL_STEP);
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const cur = out[i];
    if (cur === undefined) continue;
    const next = out[i + 1];
    cur.y = Math.min(cur.y, next === undefined ? bottom : next.y - LABEL_STEP);
    cur.y = Math.max(cur.y, top);
  }
  return out;
}

/**
 * The fences outside which a figure is far from the rest: the first quartile less `k` times the
 * interquartile range, and the third quartile plus it (quartiles by linear interpolation). With
 * fewer than four figures, or no spread between the quartiles, there are none.
 */
export function outlierFences(values: readonly number[], k = 3): { lo: number; hi: number } | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const quantile = (share: number): number => {
    const pos = (sorted.length - 1) * share;
    const below = Math.floor(pos);
    const a = sorted[below] ?? 0;
    const b = sorted[below + 1] ?? a;
    return a + (b - a) * (pos - below);
  };
  const q1 = quantile(0.25);
  const q3 = quantile(0.75);
  const spread = q3 - q1;
  if (!(spread > 0)) return null;
  return { lo: q1 - k * spread, hi: q3 + k * spread };
}
