import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import { axisLabels, linearScale, niceTicks, outlierFences, seriesColor } from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

export interface ScatterPoint {
  /** What the mark stands for, such as a company; unique within the chart. */
  label: string;
  /** Geometry only; the figures a reader sees are the two display strings. */
  x: number;
  y: number;
  xDisplay: string;
  yDisplay: string;
  /** The series the mark belongs to (one of `seriesNames`); leave out for a single-series chart. */
  series?: string | undefined;
  /** The marks the story is about; when any is set, the rest fall back to the de-emphasis tone. */
  emphasis?: boolean | undefined;
}

const PAD = { top: 12, right: 20, bottom: 44, left: 56 };
/** A held mark's ring sits this far inside the plot's edge; its arrow reaches the edge. */
const HELD_INSET = 10;

/**
 * One mark per item on two value axes, with an optional reference line where the two are equal
 * (y = x, drawn only where both axes cover it). Marks are focusable and carry their two figures
 * as their accessible name; a tooltip shows on hover and focus, the legend lists two or more
 * series, and the table twin from ChartFigure lists every mark.
 *
 * With `clampOutliers`, the x axis spans the marks within three times the interquartile range of
 * their x figures; a mark beyond is drawn at the plot's edge as a hollow ring with a short arrow
 * pointing out, its x figure printed beside it, and a line under the chart says so. The tooltip,
 * the mark's name and the table keep every exact figure. From 900px of chart width the chart is
 * 360px tall unless a height is given.
 */
export function ScatterChart({
  title,
  subtitle,
  hideCaption,
  points,
  xLabel,
  yLabel,
  xKind,
  yKind,
  seriesNames = [],
  seriesLabel = 'Series',
  equalLine = false,
  clampOutliers = false,
  summary,
  height,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  /** The section's title names the chart: the title is kept for screen readers and the table. */
  hideCaption?: boolean | undefined;
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xKind: ValueKind;
  yKind: ValueKind;
  seriesNames?: string[] | undefined;
  /** The column the table twin names the series by, such as "Entry leverage". */
  seriesLabel?: string | undefined;
  equalLine?: boolean | undefined;
  /** Hold marks far beyond the rest at the x axis's edge, so one outlier does not squeeze the others. */
  clampOutliers?: boolean | undefined;
  summary: string;
  height?: number | undefined;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width, measured] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const chartHeight = height ?? (width >= 900 ? 360 : 300);
  const fences = clampOutliers ? outlierFences(points.map((p) => p.x)) : null;
  const beyond = (p: ScatterPoint): -1 | 0 | 1 =>
    fences === null ? 0 : p.x < fences.lo ? -1 : p.x > fences.hi ? 1 : 0;
  const inside = points.filter((p) => beyond(p) === 0);
  const held = points.length - inside.length;
  const xs = inside.map((p) => p.x);
  const ys = points.map((p) => p.y);
  // Ratios keep zero in view; a figure in turns (an entry multiple) is framed by its own range.
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 5, xKind !== 'multiple');
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 5, yKind !== 'multiple');
  const xText = axisLabels(xTicks, xKind);
  const yText = axisLabels(yTicks, yKind);
  const x0 = xTicks[0] ?? 0;
  const x1 = xTicks[xTicks.length - 1] ?? 1;
  const y0 = yTicks[0] ?? 0;
  const y1 = yTicks[yTicks.length - 1] ?? 1;
  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = chartHeight - PAD.top - PAD.bottom;
  const xAt = linearScale(x0, x1, PAD.left, PAD.left + plotW);
  const yAt = linearScale(y0, y1, PAD.top + plotH, PAD.top);
  const hasEmphasis = points.some((p) => p.emphasis === true);
  const hasSeries = seriesNames.length >= 2;
  const colorOf = (p: ScatterPoint): string => {
    if (hasSeries) return seriesColor(seriesNames.indexOf(p.series ?? '') + 1);
    return hasEmphasis && p.emphasis !== true ? 'var(--pb-chart-muted)' : seriesColor(1);
  };
  // The part of y = x both axes cover; nothing is drawn when the ranges do not overlap.
  const lineLo = Math.max(x0, y0);
  const lineHi = Math.min(x1, y1);
  const xStride = Math.max(1, Math.ceil(xTicks.length / Math.max(2, Math.floor(plotW / 64))));
  /** Where a mark is drawn across: at its figure, or at the plot's edge (its arrow on the edge) when held. */
  const drawnX = (p: ScatterPoint): number => {
    const side = beyond(p);
    return side === 0 ? xAt(p.x) : side < 0 ? PAD.left + HELD_INSET : PAD.left + plotW - HELD_INSET;
  };
  const show = (p: ScatterPoint) =>
    setTooltip({
      left: Math.max(0, Math.min(drawnX(p) + 10, width - 190)),
      top: Math.max(0, yAt(p.y) - 8),
      title: p.label,
      rows: [
        { name: xLabel, value: p.xDisplay },
        { name: yLabel, value: p.yDisplay },
        ...(hasSeries && p.series !== undefined ? [{ name: seriesLabel, value: p.series }] : []),
      ],
    });
  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      hideCaption={hideCaption}
      series={hasSeries ? seriesNames.map((name, i) => ({ name, color: seriesColor(i + 1) })) : []}
      table={{
        columns: ['Position', xLabel, yLabel, ...(hasSeries ? [seriesLabel] : [])],
        rows: points.map((p) => [
          p.label,
          p.xDisplay,
          p.yDisplay,
          ...(hasSeries ? [p.series ?? '-'] : []),
        ]),
      }}
      summary={summary}
      tooltip={tooltip}
      testId={testId}
      measured={measured}
      note={
        held === 0
          ? undefined
          : held === 1
            ? '1 mark beyond the axis is drawn at its edge.'
            : `${held} marks beyond the axis are drawn at its edge.`
      }
    >
      <div ref={ref} className="pb-chart-canvas">
        <svg
          className="pb-chart-svg"
          width={width}
          height={chartHeight}
          viewBox={`0 0 ${width} ${chartHeight}`}
          role="group"
          aria-label={title}
        >
          {yTicks.map((t, i) => (
            <g key={`y${t}`}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={yAt(t)}
                y2={yAt(t)}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              <text x={PAD.left - 8} y={yAt(t) + 4} className="pb-chart-tick" textAnchor="end">
                {yText[i]}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <g key={`x${t}`}>
              <line
                x1={xAt(t)}
                x2={xAt(t)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              {i % xStride === 0 ? (
                <text
                  x={xAt(t)}
                  y={PAD.top + plotH + 16}
                  className="pb-chart-tick"
                  textAnchor="middle"
                >
                  {xText[i]}
                </text>
              ) : null}
            </g>
          ))}
          <text
            x={PAD.left + plotW / 2}
            y={chartHeight - 6}
            className="pb-chart-label"
            textAnchor="middle"
          >
            {xLabel}
          </text>
          <text
            x={12}
            y={PAD.top + plotH / 2}
            className="pb-chart-label"
            textAnchor="middle"
            transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}
          >
            {yLabel}
          </text>
          {equalLine && lineHi > lineLo ? (
            <line
              x1={xAt(lineLo)}
              y1={yAt(lineLo)}
              x2={xAt(lineHi)}
              y2={yAt(lineHi)}
              className="pb-chart-reference"
              data-testid={testId === undefined ? undefined : `${testId}-equal-line`}
            />
          ) : null}
          {points.map((p, i) => {
            const side = beyond(p);
            const cx = drawnX(p);
            const cy = yAt(p.y);
            return (
              <g key={p.label}>
                <g
                  tabIndex={0}
                  role="img"
                  aria-label={`${p.label}: ${xLabel} ${p.xDisplay}, ${yLabel} ${p.yDisplay}${
                    hasSeries && p.series !== undefined ? `, ${seriesLabel} ${p.series}` : ''
                  }`}
                  className={
                    side === 0
                      ? 'pb-chart-mark pb-chart-point'
                      : 'pb-chart-mark pb-chart-point is-held'
                  }
                  style={{ '--i': i } as CSSProperties}
                  data-held={side === 0 ? undefined : side < 0 ? 'left' : 'right'}
                  onPointerEnter={() => show(p)}
                  onPointerLeave={() => setTooltip(null)}
                  onFocus={() => show(p)}
                  onBlur={() => setTooltip(null)}
                >
                  <circle cx={cx} cy={cy} r={11} className="pb-chart-hit" />
                  {side === 0 ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={colorOf(p)}
                      stroke="var(--pb-bg)"
                      strokeWidth={1.5}
                    />
                  ) : (
                    <>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={4.5}
                        fill="var(--pb-bg)"
                        stroke={colorOf(p)}
                        strokeWidth={1.5}
                      />
                      <path
                        d={`M${cx + side * 6} ${cy - 4}L${cx + side * HELD_INSET} ${cy}L${cx + side * 6} ${cy + 4}`}
                        fill="none"
                        stroke={colorOf(p)}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </g>
                {side === 0 ? null : (
                  <text
                    x={cx - side * 8}
                    y={cy - 9}
                    className="pb-chart-value"
                    textAnchor={side < 0 ? 'start' : 'end'}
                    style={{ '--i': i } as CSSProperties}
                  >
                    {p.xDisplay}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}
