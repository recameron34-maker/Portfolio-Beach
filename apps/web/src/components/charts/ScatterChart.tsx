import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import { compactValue, linearScale, niceTicks, seriesColor } from './scale.js';
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

/**
 * One mark per item on two value axes, with an optional reference line where the two are equal
 * (y = x, drawn only where both axes cover it). Marks are focusable and carry their two figures
 * as their accessible name; a tooltip shows on hover and focus, the legend lists two or more
 * series, and the table twin from ChartFigure lists every mark.
 */
export function ScatterChart({
  title,
  subtitle,
  points,
  xLabel,
  yLabel,
  xKind,
  yKind,
  seriesNames = [],
  seriesLabel = 'Series',
  equalLine = false,
  summary,
  height = 300,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xKind: ValueKind;
  yKind: ValueKind;
  seriesNames?: string[] | undefined;
  /** The column the table twin names the series by, such as "Entry leverage". */
  seriesLabel?: string | undefined;
  equalLine?: boolean | undefined;
  summary: string;
  height?: number | undefined;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  // Ratios keep zero in view; a figure in turns (an entry multiple) is framed by its own range.
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 5, xKind !== 'multiple');
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 5, yKind !== 'multiple');
  const x0 = xTicks[0] ?? 0;
  const x1 = xTicks[xTicks.length - 1] ?? 1;
  const y0 = yTicks[0] ?? 0;
  const y1 = yTicks[yTicks.length - 1] ?? 1;
  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
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
  const show = (p: ScatterPoint) =>
    setTooltip({
      left: Math.max(0, Math.min(xAt(p.x) + 10, width - 190)),
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
    >
      <div ref={ref} className="pb-chart-canvas">
        <svg
          className="pb-chart-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title}
        >
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={yAt(t)}
                y2={yAt(t)}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              <text x={PAD.left - 8} y={yAt(t) + 4} className="pb-chart-tick" textAnchor="end">
                {compactValue(t, yKind)}
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
                  {compactValue(t, xKind)}
                </text>
              ) : null}
            </g>
          ))}
          <text
            x={PAD.left + plotW / 2}
            y={height - 6}
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
          {points.map((p) => (
            <g
              key={p.label}
              tabIndex={0}
              role="img"
              aria-label={`${p.label}: ${xLabel} ${p.xDisplay}, ${yLabel} ${p.yDisplay}${
                hasSeries && p.series !== undefined ? `, ${seriesLabel} ${p.series}` : ''
              }`}
              className="pb-chart-mark pb-chart-point"
              onPointerEnter={() => show(p)}
              onPointerLeave={() => setTooltip(null)}
              onFocus={() => show(p)}
              onBlur={() => setTooltip(null)}
            >
              <circle cx={xAt(p.x)} cy={yAt(p.y)} r={11} className="pb-chart-hit" />
              <circle
                cx={xAt(p.x)}
                cy={yAt(p.y)}
                r={5}
                fill={colorOf(p)}
                stroke="var(--pb-bg)"
                strokeWidth={1.5}
              />
            </g>
          ))}
        </svg>
      </div>
    </ChartFigure>
  );
}
