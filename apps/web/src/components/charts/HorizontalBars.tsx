import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import {
  compactValue,
  labelStride,
  linearScale,
  niceTicks,
  seriesColor,
  truncateLabel,
} from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

export interface BarDatum {
  label: string;
  value: number;
  display: string;
  /** The one bar the story is about; the rest fall back to the de-emphasis tone. */
  emphasis?: boolean | undefined;
}

const ROW = 30;
const BAR = 18;
const LABEL_W = 170;
const PAD_R = 72;

/**
 * Single-series horizontal bars (magnitude by category). Thin marks with a rounded data end,
 * a value label at the tip, hover and focus tooltips, and the table twin from ChartFigure.
 */
export function HorizontalBars({
  title,
  subtitle,
  data,
  kind,
  valueColumn,
  summary,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  data: BarDatum[];
  kind: ValueKind;
  valueColumn: string;
  summary: string;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const hasEmphasis = data.some((d) => d.emphasis === true);
  const max = Math.max(0, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const ticks = niceTicks(min, max, 4);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const plotW = Math.max(120, width - LABEL_W - PAD_R);
  const x = linearScale(lo, hi, LABEL_W, LABEL_W + plotW);
  const height = data.length * ROW + 28;
  const zero = x(0);
  const stride = labelStride(ticks.length - 1, plotW);
  const show = (d: BarDatum, i: number) =>
    setTooltip({
      left: Math.min(x(Math.max(d.value, 0)) + 8, width - 160),
      top: i * ROW,
      title: d.label,
      rows: [{ name: valueColumn, value: d.display }],
    });
  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      series={[]}
      table={{ columns: ['Category', valueColumn], rows: data.map((d) => [d.label, d.display]) }}
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
          {ticks.map((t, i) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={0}
                y2={data.length * ROW}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              {i % stride === 0 ? (
                <text
                  x={x(t)}
                  y={data.length * ROW + 18}
                  className="pb-chart-tick"
                  textAnchor="middle"
                >
                  {compactValue(t, kind)}
                </text>
              ) : null}
            </g>
          ))}
          {data.map((d, i) => {
            const y = i * ROW + (ROW - BAR) / 2;
            const start = Math.min(zero, x(d.value));
            const end = Math.max(zero, x(d.value));
            const w = Math.max(0, end - start);
            const r = Math.min(4, w);
            const path =
              d.value >= 0
                ? `M${start} ${y}H${end - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + BAR - r}a${r} ${r} 0 0 1 ${-r} ${r}H${start}Z`
                : `M${end} ${y}H${start + r}a${r} ${r} 0 0 0 ${-r} ${r}V${y + BAR - r}a${r} ${r} 0 0 0 ${r} ${r}H${end}Z`;
            const fill =
              hasEmphasis && d.emphasis !== true ? 'var(--pb-chart-muted)' : seriesColor(1);
            return (
              <g
                key={d.label}
                tabIndex={0}
                role="img"
                aria-label={`${d.label}: ${d.display}`}
                className="pb-chart-mark"
                onPointerEnter={() => show(d, i)}
                onPointerLeave={() => setTooltip(null)}
                onFocus={() => show(d, i)}
                onBlur={() => setTooltip(null)}
              >
                <rect x={0} y={i * ROW} width={width} height={ROW} className="pb-chart-hit" />
                <text
                  x={LABEL_W - 10}
                  y={y + BAR / 2 + 4}
                  className="pb-chart-label"
                  textAnchor="end"
                >
                  {truncateLabel(d.label)}
                </text>
                <path d={path} fill={fill} />
                <text x={end + 6} y={y + BAR / 2 + 4} className="pb-chart-value">
                  {d.display}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}
