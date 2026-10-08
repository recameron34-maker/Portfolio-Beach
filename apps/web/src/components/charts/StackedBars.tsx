import { useState } from 'react';
import type { ReactNode } from 'react';
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
} from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

export interface StackSegment {
  name: string;
  value: number;
  display: string;
}

export interface StackDatum {
  label: string;
  segments: StackSegment[];
}

const ROW = 30;
const BAR = 18;
/** Room right of the plot for the last tick label. */
const PAD_R = 24;
/** The plot never shrinks below this. */
const MIN_PLOT = 40;

/** Part-to-whole per category: horizontal stacked bars with a 2px surface gap between segments (six segments at most). */
export function StackedBars({
  title,
  subtitle,
  data,
  segmentNames,
  kind,
  summary,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  data: StackDatum[];
  segmentNames: string[];
  kind: ValueKind;
  summary: string;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const totals = data.map((d) => d.segments.reduce((s, seg) => s + Math.max(0, seg.value), 0));
  const ticks = niceTicks(0, Math.max(0, ...totals), 4);
  const hi = ticks[ticks.length - 1] ?? 1;
  const labelW = labelColumn(width);
  const shortLabels = chartLabels(
    data.map((d) => d.label),
    labelBudget(labelW),
  );
  const plotW = Math.max(MIN_PLOT, width - labelW - PAD_R);
  const x = linearScale(0, hi, labelW, labelW + plotW);
  const stride = labelStride(ticks.length - 1, plotW);
  const height = data.length * ROW + 28;
  const series = segmentNames.map((name, i) => ({ name, color: seriesColor(i + 1) }));
  const colorOf = (name: string) => seriesColor(segmentNames.indexOf(name) + 1);
  const show = (d: StackDatum, i: number) =>
    setTooltip({
      left: Math.max(0, Math.min(labelW + 12, width - 200)),
      top: i * ROW,
      title: d.label,
      rows: d.segments.map((s) => ({ name: s.name, value: s.display, color: colorOf(s.name) })),
    });
  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      series={series}
      table={{
        columns: ['Category', ...segmentNames],
        rows: data.map((d) => [
          d.label,
          ...segmentNames.map((n) => d.segments.find((s) => s.name === n)?.display ?? '-'),
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
            let cursor = 0;
            const positives = d.segments.filter((s) => s.value > 0);
            return (
              <g
                key={d.label}
                tabIndex={0}
                role="img"
                aria-label={`${d.label}: ${d.segments.map((s) => `${s.name} ${s.display}`).join(', ')}`}
                className="pb-chart-mark"
                onPointerEnter={() => show(d, i)}
                onPointerLeave={() => setTooltip(null)}
                onFocus={() => show(d, i)}
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
                {positives.map((s, si) => {
                  const start = x(cursor);
                  cursor += s.value;
                  const end = x(cursor);
                  const w = Math.max(0, end - start);
                  const last = si === positives.length - 1;
                  const r = last ? Math.min(4, w) : 0;
                  const path = `M${start} ${y}H${end - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + BAR - r}a${r} ${r} 0 0 1 ${-r} ${r}H${start}Z`;
                  const fits = w >= s.display.length * 7 + 12;
                  return (
                    <g key={s.name}>
                      <path d={path} fill={colorOf(s.name)} stroke="var(--pb-bg)" strokeWidth={2} />
                      {fits ? (
                        <text
                          x={start + w / 2}
                          y={y + BAR / 2 + 4}
                          className="pb-chart-inlabel"
                          textAnchor="middle"
                        >
                          {s.display}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}
