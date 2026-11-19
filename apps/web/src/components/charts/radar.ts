/**
 * The geometry of a radar chart: measures on spokes from one centre, the first at the top and the
 * rest clockwise, each from 0 at the centre to 100 at the rim. Number is used here for drawing
 * only; the figure a reader sees beside a point is the one the API gave.
 */

const angleOf = (index: number, count: number): number =>
  -Math.PI / 2 + (2 * Math.PI * index) / count;

const clean = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

/** Where a score sits on its spoke; a score outside 0 to 100 is held at the end it passed. */
export function radarPoint(
  index: number,
  count: number,
  value: number,
  radius: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const reach = (Math.min(Math.max(value, 0), 100) / 100) * radius;
  const angle = angleOf(index, count);
  return { x: clean(cx + reach * Math.cos(angle)), y: clean(cy + reach * Math.sin(angle)) };
}

/** The outline through every spoke at a share of the radius, as SVG polygon points. */
export function radarRing(
  count: number,
  share: number,
  radius: number,
  cx: number,
  cy: number,
): string {
  return Array.from({ length: count }, (_, i) => {
    const p = radarPoint(i, count, share * 100, radius, cx, cy);
    return `${p.x},${p.y}`;
  }).join(' ');
}

export interface RadarShape {
  /** A point for each measure that has a score, in order. */
  points: { key: string; index: number; x: number; y: number }[];
  /** The line through each run of neighbouring scores, as SVG path data; empty for none. */
  outline: string;
  /** The filled area under those lines, each run closed through the centre. */
  area: string;
}

/**
 * The shape of the scores. A measure with none leaves a gap: it is never drawn at the centre as a
 * zero, and no line crosses it from one neighbour to the other, since either would say something
 * about a figure that is not recorded.
 */
export function radarShape(
  axes: readonly { key: string; value: number | null }[],
  radius: number,
  cx: number,
  cy: number,
): RadarShape {
  const count = axes.length;
  const at = axes.map((axis, index) =>
    axis.value === null
      ? null
      : { key: axis.key, index, ...radarPoint(index, count, axis.value, radius, cx, cy) },
  );
  const points = at.flatMap((p) => (p === null ? [] : [p]));
  const line = (run: readonly { x: number; y: number }[]): string =>
    run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join('');

  if (count >= 3 && points.length === count) {
    const closed = `${line(points)}Z`;
    return { points, outline: closed, area: closed };
  }

  let outline = '';
  let area = '';
  for (let start = 0; start < count; start += 1) {
    // A run starts at a score whose neighbour before it has none.
    if (at[start] === null || at[(start - 1 + count) % count] !== null) continue;
    const run: { x: number; y: number }[] = [];
    for (let step = 0; step < count; step += 1) {
      const p = at[(start + step) % count];
      if (p === null || p === undefined) break;
      run.push(p);
    }
    if (run.length < 2) continue;
    outline += line(run);
    area += `M${cx},${cy}${line(run).replace('M', 'L')}Z`;
  }
  return { points, outline, area };
}

/**
 * Where a ring's figure is written: half way along the ring's side between the last spoke and the
 * first, so it sits beside the top spoke and never on a score.
 */
export function radarRingLabel(
  count: number,
  share: number,
  radius: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const first = radarPoint(0, count, share * 100, radius, cx, cy);
  const last = radarPoint(count - 1, count, share * 100, radius, cx, cy);
  return { x: clean((first.x + last.x) / 2), y: clean((first.y + last.y) / 2) };
}

/** How a label is set against its spoke: centred at the top and bottom, outward at the sides. */
export function radarAnchor(index: number, count: number): 'start' | 'middle' | 'end' {
  const across = Math.cos(angleOf(index, count));
  if (Math.abs(across) < 0.2) return 'middle';
  return across > 0 ? 'start' : 'end';
}

/** Room kept beside the chart for the labels, and above and below it for three short lines. */
const LABEL_ROOM_X = 84;
const LABEL_ROOM_Y = 54;
const MAX_RADIUS = 180;
const MIN_RADIUS = 48;

export interface RadarLayout {
  radius: number;
  cx: number;
  cy: number;
  height: number;
}

/** The chart for a canvas of a given width: centred, as large as the labels leave room for. */
export function radarLayout(width: number): RadarLayout {
  const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.floor(width / 2) - LABEL_ROOM_X));
  const cx = Math.max(Math.floor(width / 2), radius + LABEL_ROOM_X);
  const cy = radius + LABEL_ROOM_Y;
  return { radius, cx, cy, height: cy * 2 };
}
