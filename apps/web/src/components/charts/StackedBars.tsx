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

/** Room right of the plot for the last tick label. */
const PAD_R = 24;
/** Room right of the plot when a one-segment bar prints its value past its tip. */
const PAD_R_VALUE = 72;
/** The plot never shrinks below this. */
const MIN_PLOT = 40;

/**
 * Part-to-whole per category: horizontal stacked bars, 12px tall with square ends, a 1px page
 * coloured rule between segments (six segments at most). A bar of one segment prints its value
 * past its tip, as single bars do; in a bar of several, each value that fits its segment is
 * printed inside it on a plate of the page colour. Labels follow the bar charts' layout: whole
 * above each bar under 480px of chart width, cut to fit beside it from there.
 */
export function StackedBars({
  title,
  subtitle,
  hideCaption,
  data,
  segmentNames,
  kind,
  summary,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  /** The section's title names the chart: the title is kept for screen readers and the table. */
  hideCaption?: boolean | undefined;
  data: StackDatum[];
  segmentNames: string[];
  kind: ValueKind;
  summary: string;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width, measured] = useWidth();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const totals = data.map((d) => d.segments.reduce((s, seg) => s + Math.max(0, seg.value), 0));
  const ticks = niceTicks(0, Math.max(0, ...totals), 4);
  const tickText = axisLabels(ticks, kind);
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
  const single = (d: StackDatum): boolean => d.segments.filter((s) => s.value > 0).length === 1;
  const padR = data.some(single) ? PAD_R_VALUE : PAD_R;
  const plotW = Math.max(MIN_PLOT, width - rows.plotLeft - padR);
  const x = linearScale(0, hi, rows.plotLeft, rows.plotLeft + plotW);
  const stride = labelStride(ticks.length - 1, plotW);
  const height = data.length * ROW + 28;
  const series = segmentNames.map((name, i) => ({ name, color: seriesColor(i + 1) }));
  const colorOf = (name: string) => seriesColor(segmentNames.indexOf(name) + 1);
  const show = (d: StackDatum, i: number) =>
    setTooltip({
      left: Math.max(0, Math.min(rows.plotLeft + 12, width - 200)),
      top: i * ROW,
      title: d.label,
      rows: d.segments.map((s) => ({ name: s.name, value: s.display, color: colorOf(s.name) })),
    });
  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      hideCaption={hideCaption}
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
            let cursor = 0;
            const positives = d.segments.filter((s) => s.value > 0);
            const alone = positives.length === 1;
            return (
              <g
                key={d.label}
                tabIndex={0}
                role="img"
                aria-label={`${d.label}: ${d.segments.map((s) => `${s.name} ${s.display}`).join(', ')}`}
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
                {positives.map((s, si) => {
                  const start = x(cursor);
                  cursor += s.value;
                  const end = x(cursor);
                  const w = Math.max(0, end - start);
                  const last = si === positives.length - 1;
                  const r = last ? Math.min(1, w) : 0;
                  const path = `M${start} ${y}H${end - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + BAR - r}a${r} ${r} 0 0 1 ${-r} ${r}H${start}Z`;
                  if (alone) {
                    const value = valueLabelPosition(end, width);
                    return (
                      <g key={s.name}>
                        <path d={path} fill={colorOf(s.name)} className="pb-chart-bar" />
                        <text
                          x={value.x}
                          y={y + BAR / 2 + 4}
                          className="pb-chart-value"
                          textAnchor={value.anchor}
                        >
                          {s.display}
                        </text>
                      </g>
                    );
                  }
                  const fits = w >= s.display.length * 7 + 12;
                  // The label sits on a plate in the page colour: no series colour gives either
                  // text colour 4.5:1 on its own (lib/theme.test.ts documents the pairs).
                  const plateW = s.display.length * 6.6 + 8;
                  return (
                    <g key={s.name}>
                      <path
                        d={path}
                        fill={colorOf(s.name)}
                        stroke="var(--pb-bg)"
                        strokeWidth={1}
                        className="pb-chart-bar"
                      />
                      {fits ? (
                        <g className="pb-chart-inlabel">
                          <rect
                            x={start + w / 2 - plateW / 2}
                            y={y + BAR / 2 - 7}
                            width={plateW}
                            height={14}
                            rx={2}
                            className="pb-chart-inlabel-plate"
                          />
                          <text
                            x={start + w / 2}
                            y={y + BAR / 2 + 4}
                            className="pb-chart-inlabel-text"
                            textAnchor="middle"
                          >
                            {s.display}
                          </text>
                        </g>
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
