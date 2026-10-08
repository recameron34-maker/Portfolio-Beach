import { useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import { compactValue, linearScale, niceTicks, seriesColor } from './scale.js';
import type { ValueKind } from './scale.js';
import { useWidth } from './useWidth.js';

export interface LineSeries {
  name: string;
  values: (number | null)[];
}

const PAD = { top: 12, right: 96, bottom: 28, left: 56 };

/**
 * Trend over time for one or more series: 2px lines, end markers with a surface ring, a wash
 * under a single series, a crosshair tooltip that lists every series at the nearest x, keyboard
 * navigation with the arrow keys, direct end labels for up to four series and the table twin.
 */
export function LineChart({
  title,
  subtitle,
  x,
  series,
  kind,
  format,
  summary,
  height = 240,
  baselineZero = true,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  x: string[];
  series: LineSeries[];
  kind: ValueKind;
  format: (value: number) => string;
  summary: string;
  height?: number | undefined;
  baselineZero?: boolean | undefined;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0), 4, baselineZero);
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 1;
  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (x.length <= 1 ? plotW / 2 : (i / (x.length - 1)) * plotW);
  const yAt = linearScale(lo, hi, PAD.top + plotH, PAD.top);
  const keys = series.map((s, i) => ({ name: s.name, color: seriesColor(i + 1) }));
  const labelEvery = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(plotW / 90))));

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
                ? 'n/a'
                : format(s.values[active]),
            color: seriesColor(i + 1),
          })),
        };

  // End labels for up to four series; a label too close to the previous one is dropped (the legend carries it).
  const endLabels: { name: string; y: number; color: string }[] = [];
  if (series.length <= 4) {
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
          : { name: s.name, y: yAt(v), color: seriesColor(i + 1) };
      })
      .filter((c): c is { name: string; y: number; color: string } => c !== null)
      .sort((a, b) => a.y - b.y);
    for (const c of candidates) {
      const prev = endLabels[endLabels.length - 1];
      if (prev === undefined || c.y - prev.y >= 14) endLabels.push(c);
    }
  }

  return (
    <ChartFigure
      title={title}
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
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={yAt(t)}
                y2={yAt(t)}
                className={t === 0 ? 'pb-chart-axis' : 'pb-chart-grid'}
              />
              <text x={PAD.left - 8} y={yAt(t) + 4} className="pb-chart-tick" textAnchor="end">
                {compactValue(t, kind)}
              </text>
            </g>
          ))}
          {x.map((label, i) =>
            (x.length - 1 - i) % labelEvery === 0 ? (
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
            const points = s.values
              .map((v, i) => (v === null ? null : `${xAt(i)} ${yAt(v)}`))
              .filter((p): p is string => p !== null);
            const d = points.length === 0 ? '' : `M${points.join('L')}`;
            const color = seriesColor(si + 1);
            const firstIdx = s.values.findIndex((v) => v !== null);
            let lastIdx = -1;
            for (let j = s.values.length - 1; j >= 0; j--) {
              if (s.values[j] !== null) {
                lastIdx = j;
                break;
              }
            }
            const lastValue = lastIdx >= 0 ? s.values[lastIdx] : null;
            return (
              <g key={s.name}>
                {series.length === 1 && points.length > 1 && firstIdx >= 0 ? (
                  <path
                    d={`${d}L${xAt(lastIdx)} ${yAt(Math.max(lo, 0))}L${xAt(firstIdx)} ${yAt(Math.max(lo, 0))}Z`}
                    fill={color}
                    opacity={0.1}
                  />
                ) : null}
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {lastValue !== null && lastValue !== undefined ? (
                  <circle
                    cx={xAt(lastIdx)}
                    cy={yAt(lastValue)}
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
            <text key={l.name} x={PAD.left + plotW + 10} y={l.y + 4} className="pb-chart-label">
              {l.name}
            </text>
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
          {tooltip === null
            ? ''
            : `${tooltip.title}: ${tooltip.rows.map((r) => `${r.name} ${r.value}`).join(', ')}`}
        </p>
      </div>
    </ChartFigure>
  );
}
