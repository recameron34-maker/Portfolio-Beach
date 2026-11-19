import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import {
  BAR,
  barRows,
  chartLabels,
  axisLabels,
  labelBudget,
  labelStride,
  linearScale,
  niceTicks,
  seriesColor,
  tickAnchor,
  valueLabelPosition,
} from './scale.js';
import type { ValueKind } from './scale.js';
import { useSharedDomain } from './shared-scale.js';
import { useWidth } from './useWidth.js';

export interface BarDatum {
  label: string;
  value: number;
  display: string;
  /** The one bar the story is about; the rest fall back to the de-emphasis tone. */
  emphasis?: boolean | undefined;
}

/** Room right of the plot for the value label at the end of the longest bar. */
const PAD_R = 72;
/** The plot never shrinks below this; the value labels then hold to the chart's right edge. */
const MIN_PLOT = 40;

/**
 * Single-series horizontal bars (magnitude by category): 12px bars with square ends, a value
 * label at the tip, hover and focus tooltips, and the table twin from ChartFigure. Under 480px of
 * chart width each label sits whole on its own line above its bar; beside the bars a label too
 * long for its column is cut. Inside a SharedScale the value axis is shared with its neighbours.
 */
export function HorizontalBars({
  title,
  heading,
  hideCaption,
  subtitle,
  data,
  kind,
  valueColumn,
  summary,
  testId,
}: {
  title: string;
  /** The title is the section's heading (an h2): the chart is all its section holds. */
  heading?: boolean | undefined;
  hideCaption?: boolean | undefined;
  subtitle?: string | undefined;
  data: BarDatum[];
  kind: ValueKind;
  valueColumn: string;
  summary: string;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width, measured] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const hasEmphasis = data.some((d) => d.emphasis === true);
  const [min, max] = useSharedDomain(
    Math.min(0, ...data.map((d) => d.value)),
    Math.max(0, ...data.map((d) => d.value)),
  );
  const ticks = niceTicks(min, max, 4);
  const tickText = axisLabels(ticks, kind);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const rows = barRows(
    width,
    data.map((d) => d.label),
  );
  const ROW = rows.row;
  const labels =
    rows.layout === 'side'
      ? chartLabels(
          data.map((d) => d.label),
          labelBudget(rows.labelWidth),
        )
      : data.map((d) => d.label);
  const plotW = Math.max(MIN_PLOT, width - rows.plotLeft - PAD_R);
  const x = linearScale(lo, hi, rows.plotLeft, rows.plotLeft + plotW);
  const height = data.length * ROW + 28;
  const zero = x(0);
  const stride = labelStride(ticks.length - 1, plotW);
  const show = (d: BarDatum, i: number) =>
    setTooltip({
      left: Math.max(0, Math.min(x(Math.max(d.value, 0)) + 8, width - 160)),
      top: i * ROW,
      title: d.label,
      rows: [{ name: valueColumn, value: d.display }],
    });
  return (
    <ChartFigure
      title={title}
      heading={heading}
      hideCaption={hideCaption}
      subtitle={subtitle}
      series={[]}
      table={{ columns: ['Category', valueColumn], rows: data.map((d) => [d.label, d.display]) }}
      summary={summary}
      tooltip={tooltip}
      testId={testId}
      measured={measured}
    >
      <div ref={ref} className="pb-chart-canvas">
        <svg
          className="pb-chart-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title}
          data-labels={rows.layout}
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
                  textAnchor={tickAnchor(x(t))}
                >
                  {tickText[i]}
                </text>
              ) : null}
            </g>
          ))}
          {data.map((d, i) => {
            const y = i * ROW + rows.barTop;
            const start = Math.min(zero, x(d.value));
            const end = Math.max(zero, x(d.value));
            const w = Math.max(0, end - start);
            // Square ends: at most a 1px softening at the data end.
            const r = Math.min(1, w);
            const path =
              d.value >= 0
                ? `M${start} ${y}H${end - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + BAR - r}a${r} ${r} 0 0 1 ${-r} ${r}H${start}Z`
                : `M${end} ${y}H${start + r}a${r} ${r} 0 0 0 ${-r} ${r}V${y + BAR - r}a${r} ${r} 0 0 0 ${r} ${r}H${end}Z`;
            const fill =
              hasEmphasis && d.emphasis !== true ? 'var(--pb-chart-muted)' : seriesColor(1);
            const value = valueLabelPosition(end, width);
            return (
              <g
                key={d.label}
                tabIndex={0}
                role="img"
                aria-label={`${d.label}: ${d.display}`}
                className="pb-chart-mark"
                style={{ '--i': i } as CSSProperties}
                onPointerEnter={() => show(d, i)}
                onPointerLeave={() => setTooltip(null)}
                onFocus={() => show(d, i)}
                onBlur={() => setTooltip(null)}
              >
                <rect x={0} y={i * ROW} width={width} height={ROW} className="pb-chart-hit" />
                <text
                  x={rows.labelX}
                  y={i * ROW + rows.labelBaseline}
                  className="pb-chart-label"
                  textAnchor={rows.labelAnchor}
                >
                  {labels[i]}
                </text>
                <path
                  d={path}
                  fill={fill}
                  className={d.value < 0 ? 'pb-chart-bar is-negative' : 'pb-chart-bar'}
                />
                <text
                  x={value.x}
                  y={y + BAR / 2 + 4}
                  className="pb-chart-value"
                  textAnchor={value.anchor}
                >
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
