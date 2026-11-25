import { useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { MISSING } from '../../lib/format.js';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import {
  axisLabels,
  dodge,
  knownRuns,
  labelPx,
  linearScale,
  niceTicks,
  seriesColor,
} from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

export interface LineSeries {
  name: string;
  values: (number | null)[];
  /**
   * True at a point this series does not have by design (a date that belongs to another series
   * of the chart): its line runs over it. A null anywhere else is a missing figure and a gap.
   */
  absent?: readonly boolean[] | undefined;
}

const PAD = { top: 12, right: 96, bottom: 28, left: 56 };
/** Right of the plot when no end label is drawn: room for half the last date under the axis. */
const PAD_RIGHT_BARE = 28;
/** The gap an axis break leaves in the gridlines. */
const BREAK_GAP = 12;
/** A tick's type size against the 12px a category label is estimated at (labelPx). */
const TICK_PX = 11;
const LABEL_PX = 12;
/** The least space between the pinned label before an axis break and the next label named. */
const TICK_LABEL_GAP = 10;

/**
 * Trend over time for one or more series: 1.75px lines with no wash under them, end markers with
 * a surface ring, a crosshair tooltip that lists every series at the nearest x, keyboard
 * navigation with the arrow keys, direct end labels for two to four series and the table twin. A
 * null value is a gap: the line stops before it and starts again after it. One series has no end
 * label: the chart's title names it. End labels that would touch move apart, each joined to its
 * line by a short leader, so none is dropped.
 *
 * The points sit at even steps unless `at` places them: one number per point, rising (days since
 * the first date, say), so points that are unevenly spaced in time are drawn that far apart and a
 * straight line in time is a straight line on the chart. `breakAfter` marks the axis broken after
 * a point (an entry date before evenly spaced quarters). With `baselineZero` false the axis spans
 * the figures only, and its lowest gridline is labelled like every other.
 */
export function LineChart({
  title,
  heading,
  hideCaption,
  subtitle,
  x,
  at,
  series,
  kind,
  format,
  summary,
  height = 240,
  baselineZero = true,
  breakAfter,
  testId,
}: {
  title: string;
  /** The title is the section's heading (an h2): the chart is all its section holds. */
  heading?: boolean | undefined;
  hideCaption?: boolean | undefined;
  subtitle?: string | undefined;
  x: string[];
  /** Where each point sits along the axis, in any unit; left out, the points are evenly spaced. */
  at?: readonly number[] | undefined;
  series: LineSeries[];
  kind: ValueKind;
  format: (value: number) => string;
  summary: string;
  height?: number | undefined;
  baselineZero?: boolean | undefined;
  /** The axis is broken between this point and the next: their spacing is not to scale. */
  breakAfter?: number | undefined;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width, measured] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = baselineZero
    ? niceTicks(Math.min(...all, 0), Math.max(...all, 0), 4, true)
    : niceTicks(Math.min(...all), Math.max(...all), 4, false);
  const tickText = axisLabels(ticks, kind);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const labelled = series.length >= 2 && series.length <= 4;
  const padRight = labelled ? PAD.right : PAD_RIGHT_BARE;
  const plotW = Math.max(120, width - PAD.left - padRight);
  const plotH = height - PAD.top - PAD.bottom;
  // The share of the axis each point sits at: its place in `at` when every point has one and
  // they span a range, else its even step.
  const first = at?.[0];
  const last = at?.[x.length - 1];
  const span =
    at?.length === x.length && first !== undefined && last !== undefined ? last - first : 0;
  const shareAt = (i: number): number =>
    span > 0 ? ((at?.[i] ?? 0) - (first ?? 0)) / span : i / (x.length - 1);
  const xAt = (i: number) => PAD.left + (x.length <= 1 ? plotW / 2 : shareAt(i) * plotW);
  const yAt = linearScale(lo, hi, PAD.top + plotH, PAD.top);
  const keys = series.map((s, i) => ({ name: s.name, color: seriesColor(i + 1) }));
  const labelEvery = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(plotW / 90))));
  // Which points are named under the axis. Evenly spaced points take every nth from the right;
  // placed points take, from the right, each one far enough from the last one named. The point
  // before an axis break is always named (the break means nothing without "Entry" under it), and
  // a label that would run into it is left out instead.
  const pinned =
    breakAfter !== undefined && breakAfter >= 0 && breakAfter < x.length - 1 ? breakAfter : null;
  const half = (i: number): number => (labelPx(x[i] ?? '') * TICK_PX) / LABEL_PX / 2;
  const clearOfPinned = (i: number): boolean =>
    pinned === null ||
    i === pinned ||
    Math.abs(xAt(i) - xAt(pinned)) >= half(i) + half(pinned) + TICK_LABEL_GAP;
  const named = new Set<number>();
  if (pinned !== null) named.add(pinned);
  if (span > 0) {
    let lastNamed = Infinity;
    for (let i = x.length - 1; i >= 0; i--) {
      if (lastNamed - xAt(i) < 90 || !clearOfPinned(i)) continue;
      named.add(i);
      lastNamed = xAt(i);
    }
  } else {
    for (let i = 0; i < x.length; i++)
      if ((x.length - 1 - i) % labelEvery === 0 && clearOfPinned(i)) named.add(i);
  }

  const nearest = (clientX: number, el: SVGSVGElement): number => {
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(xAt(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setActive(nearest(e.clientX, e.currentTarget));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((a) => {
        const from = a ?? (e.key === 'ArrowRight' ? -1 : x.length);
        return Math.min(x.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    }
    if (e.key === 'Escape') setActive(null);
  };

  const tooltip: TooltipState | null =
    active === null
      ? null
      : {
          left: Math.min(xAt(active) + 10, width - 190),
          top: PAD.top,
          title: x[active] ?? '',
          rows: series.map((s, i) => ({
            name: s.name,
            value:
              s.values[active] === null || s.values[active] === undefined
                ? MISSING
                : format(s.values[active]),
            color: seriesColor(i + 1),
          })),
        };
  // The live region names a missing figure in words; the tooltip shows the placeholder.
  const spoken =
    active === null
      ? ''
      : `${x[active] ?? ''}: ${series
          .map((s) => {
            const v = s.values[active];
            return `${s.name} ${v === null || v === undefined ? 'n/a' : format(v)}`;
          })
          .join(', ')}`;

  // End labels for two to four series, apart by at least LABEL_STEP: each moves down off the one
  // above it, and back up from the plot's foot when the last would fall below it. One series
  // needs none: the chart's title names it.
  const endLabels: { name: string; y: number; at: number; color: string }[] = [];
  if (labelled) {
    const candidates = series
      .map((s, i) => {
        let last = -1;
        for (let j = s.values.length - 1; j >= 0; j--) {
          if (s.values[j] !== null) {
            last = j;
            break;
          }
        }
        const v = last >= 0 ? s.values[last] : null;
        return v === null || v === undefined
          ? null
          : { name: s.name, y: yAt(v), at: yAt(v), color: seriesColor(i + 1) };
      })
      .filter((c): c is { name: string; y: number; at: number; color: string } => c !== null)
      .sort((a, b) => a.y - b.y);
    endLabels.push(...dodge(candidates, PAD.top, PAD.top + plotH));
  }
  // An axis break: a gap in the gridlines half way between the two points, two strokes across
  // the foot. The lines themselves run on, since a gap in a line means a missing figure.
  const breakAt =
    breakAfter !== undefined && breakAfter >= 0 && breakAfter < x.length - 1
      ? (xAt(breakAfter) + xAt(breakAfter + 1)) / 2
      : null;
  const rule = (y: number, className: string, key: string): ReactNode =>
    breakAt === null ? (
      <line key={key} x1={PAD.left} x2={PAD.left + plotW} y1={y} y2={y} className={className} />
    ) : (
      <g key={key}>
        <line x1={PAD.left} x2={breakAt - BREAK_GAP / 2} y1={y} y2={y} className={className} />
        <line
          x1={breakAt + BREAK_GAP / 2}
          x2={PAD.left + plotW}
          y1={y}
          y2={y}
          className={className}
        />
      </g>
    );

  return (
    <ChartFigure
      title={title}
      heading={heading}
      subtitle={subtitle}
      series={keys}
      table={{
        columns: ['Period', ...series.map((s) => s.name)],
        rows: x.map((label, i) => [
          label,
          ...series.map((s) =>
            s.values[i] === null || s.values[i] === undefined ? '-' : format(s.values[i]),
          ),
        ]),
      }}
      summary={summary}
      tooltip={tooltip}
      testId={testId}
      measured={measured}
      hideCaption={hideCaption}
    >
      <div ref={ref} className="pb-chart-canvas">
        <svg
          className="pb-chart-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          {ticks.map((t, i) => (
            <g key={t}>
              {rule(yAt(t), t === 0 && baselineZero ? 'pb-chart-axis' : 'pb-chart-grid', 'rule')}
              <text x={PAD.left - 8} y={yAt(t) + 4} className="pb-chart-tick" textAnchor="end">
                {tickText[i]}
              </text>
            </g>
          ))}
          {breakAt === null ? null : (
            <g className="pb-chart-break" aria-hidden="true">
              {[breakAt - BREAK_GAP / 2, breakAt + BREAK_GAP / 2].map((bx) => (
                <line
                  key={bx}
                  x1={bx - 2}
                  x2={bx + 2}
                  y1={PAD.top + plotH + 5}
                  y2={PAD.top + plotH - 5}
                />
              ))}
            </g>
          )}
          {x.map((label, i) =>
            named.has(i) ? (
              <text
                key={label}
                x={xAt(i)}
                y={height - 8}
                className="pb-chart-tick"
                textAnchor="middle"
              >
                {label}
              </text>
            ) : null,
          )}
          {series.map((s, si) => {
            const color = seriesColor(si + 1);
            const runs = knownRuns(s.values, s.absent);
            const lastRun = runs[runs.length - 1];
            const end = lastRun?.[lastRun.length - 1];
            return (
              <g key={s.name}>
                {runs.map((run) => {
                  const first = run[0];
                  const last = run[run.length - 1];
                  if (first === undefined || last === undefined) return null;
                  const d = `M${run.map((p) => `${xAt(p.i)} ${yAt(p.v)}`).join('L')}`;
                  return (
                    <g key={first.i}>
                      {run.length > 1 ? (
                        <path
                          className="pb-chart-line"
                          d={d}
                          pathLength={1}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.75}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      ) : (
                        <circle cx={xAt(first.i)} cy={yAt(first.v)} r={2.5} fill={color} />
                      )}
                    </g>
                  );
                })}
                {end !== undefined ? (
                  <circle
                    className="pb-chart-end"
                    cx={xAt(end.i)}
                    cy={yAt(end.v)}
                    r={4}
                    fill={color}
                    stroke="var(--pb-bg)"
                    strokeWidth={2}
                  />
                ) : null}
              </g>
            );
          })}
          {endLabels.map((l) => (
            <g key={l.name} className="pb-chart-end">
              {Math.abs(l.y - l.at) > 1 ? (
                <line
                  x1={PAD.left + plotW + 3}
                  y1={l.at}
                  x2={PAD.left + plotW + 8}
                  y2={l.y}
                  className="pb-chart-leader"
                />
              ) : null}
              <text x={PAD.left + plotW + 10} y={l.y + 4} className="pb-chart-label">
                {l.name}
              </text>
            </g>
          ))}
          {active !== null ? (
            <g>
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                className="pb-chart-crosshair"
              />
              {series.map((s, si) => {
                const v = s.values[active];
                return v === null || v === undefined ? null : (
                  <circle
                    key={s.name}
                    cx={xAt(active)}
                    cy={yAt(v)}
                    r={4}
                    fill={seriesColor(si + 1)}
                    stroke="var(--pb-bg)"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
        <p className="pb-visually-hidden" aria-live="polite" aria-atomic="true">
          {spoken}
        </p>
      </div>
    </ChartFigure>
  );
}
