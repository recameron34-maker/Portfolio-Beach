import { useState } from 'react';
import type { ReactNode } from 'react';
import { bridgeSpans } from './bridge.js';
import type { BridgeStep } from './bridge.js';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import {
  chartLabels,
  compactValue,
  LABEL_GAP,
  labelBudget,
  labelColumn,
  labelStride,
  linearScale,
  niceTicks,
  seriesColor,
  valueLabelPosition,
} from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

const ROW = 30;
const BAR = 18;
/** Room right of the plot for the value label at the end of the longest bar. */
const PAD_R = 76;
/** The plot never shrinks below this; the value labels then hold to the chart's right edge. */
const MIN_PLOT = 40;

/**
 * A bridge (waterfall) from a starting total through signed steps to an ending total, one row
 * per step: totals in the neutral tone, increases in the first series colour, decreases in the
 * second. Each bar carries its figure as text, so colour is never the only signal; a connector
 * joins each step to the next. Hover and focus tooltips and the table twin come from ChartFigure.
 */
export function BridgeChart({
  title,
  subtitle,
  steps,
  kind,
  summary,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  steps: BridgeStep[];
  kind: ValueKind;
  summary: string;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const spans = bridgeSpans(steps);
  const levels = spans.flatMap((s) => [s.from, s.to]);
  const ticks = niceTicks(Math.min(0, ...levels), Math.max(0, ...levels), 4);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const labelW = labelColumn(width);
  const shortLabels = chartLabels(
    steps.map((s) => s.label),
    labelBudget(labelW),
  );
  const plotW = Math.max(MIN_PLOT, width - labelW - PAD_R);
  const x = linearScale(lo, hi, labelW, labelW + plotW);
  const height = steps.length * ROW + 28;
  const stride = labelStride(ticks.length - 1, plotW);
  const fillOf = (step: BridgeStep): string =>
    step.kind === 'total'
      ? 'var(--pb-chart-muted)'
      : step.value < 0
        ? seriesColor(2)
        : seriesColor(1);
  const show = (step: BridgeStep, i: number, end: number) =>
    setTooltip({
      left: Math.max(0, Math.min(end + 8, width - 170)),
      top: i * ROW,
      title: step.label,
      rows: [{ name: step.kind === 'total' ? 'Level' : 'Change', value: step.display }],
    });
  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      series={[
        { name: 'Increase', color: seriesColor(1) },
        { name: 'Decrease', color: seriesColor(2) },
      ]}
      table={{ columns: ['Step', 'Amount'], rows: steps.map((s) => [s.label, s.display]) }}
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
                y2={steps.length * ROW}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              {i % stride === 0 ? (
                <text
                  x={x(t)}
                  y={steps.length * ROW + 18}
                  className="pb-chart-tick"
                  textAnchor="middle"
                >
                  {compactValue(t, kind)}
                </text>
              ) : null}
            </g>
          ))}
          {steps.map((step, i) => {
            const span = spans[i] ?? { from: 0, to: 0 };
            const y = i * ROW + (ROW - BAR) / 2;
            const start = Math.min(x(span.from), x(span.to));
            const end = Math.max(x(span.from), x(span.to));
            const value = valueLabelPosition(end, width);
            const next = spans[i + 1];
            return (
              <g
                key={step.label}
                tabIndex={0}
                role="img"
                aria-label={`${step.label}: ${step.display}`}
                className="pb-chart-mark"
                onPointerEnter={() => show(step, i, end)}
                onPointerLeave={() => setTooltip(null)}
                onFocus={() => show(step, i, end)}
                onBlur={() => setTooltip(null)}
              >
                <rect x={0} y={i * ROW} width={width} height={ROW} className="pb-chart-hit" />
                <text
                  x={labelW - LABEL_GAP}
                  y={y + BAR / 2 + 4}
                  className="pb-chart-label"
                  textAnchor="end"
                >
                  {shortLabels[i]}
                </text>
                <path
                  d={`M${start} ${y}h${Math.max(1, end - start)}v${BAR}h${-Math.max(1, end - start)}Z`}
                  fill={fillOf(step)}
                />
                {next !== undefined ? (
                  <line
                    x1={x(span.to)}
                    x2={x(span.to)}
                    y1={y + BAR}
                    y2={y + ROW}
                    className="pb-chart-crosshair"
                  />
                ) : null}
                <text
                  x={value.x}
                  y={y + BAR / 2 + 4}
                  className="pb-chart-value"
                  textAnchor={value.anchor}
                >
                  {step.display}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}
