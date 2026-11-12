import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChartFigure } from './ChartFigure.js';
import type { TooltipState } from './ChartFigure.js';
import {
  radarAnchor,
  radarLayout,
  radarPoint,
  radarRing,
  radarRingLabel,
  radarShape,
} from './radar.js';
import { seriesColor } from './scale.js';
import { useWidth } from './useWidth.js';

export interface RadarAxis {
  key: string;
  /** One or two short words; two are set on two lines. */
  label: string;
  /** 0 to 100 for drawing; null when the measure has no score. */
  value: number | null;
  /** The score as the reader sees it, or the missing placeholder. */
  display: string;
  /** A sentence for the tooltip: the figure behind the score, or why there is none. */
  note?: string | undefined;
}

const RINGS = [0.25, 0.5, 0.75, 1];
const LINE = 14;
/** How far past the rim a label starts. */
const LABEL_GAP = 12;
const TOOLTIP_WIDTH = 220;

/**
 * A radar chart: one spoke per measure from 0 at the centre to 100 at the rim, the scores joined
 * into a shape. A measure with no score is drawn as a dashed spoke with the missing placeholder
 * and leaves a gap in the shape (see radarShape). The score is printed at every label, so nothing
 * is said by position alone; the table twin of ChartFigure carries the same rows.
 */
export function RadarChart({
  title,
  subtitle,
  axes,
  summary,
  valueColumn,
  activeKey,
  onActive,
  testId,
}: {
  title: string;
  subtitle?: string | undefined;
  axes: readonly RadarAxis[];
  summary: string;
  valueColumn: string;
  /** The measure to bring forward, when something outside the chart points at one. */
  activeKey?: string | null | undefined;
  onActive?: ((key: string | null) => void) | undefined;
  testId?: string | undefined;
}): ReactNode {
  const [ref, width] = useWidth(480);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const { radius, cx, cy, height } = radarLayout(width);
  const count = axes.length;
  const shape = radarShape(axes, radius, cx, cy);
  const color = seriesColor(1);

  /** Where a measure's label block starts and how its lines are set (shared by the label and the tooltip). */
  const labelOf = (axis: RadarAxis, index: number) => {
    const at = radarPoint(index, count, 100, radius + LABEL_GAP, cx, cy);
    const anchor = radarAnchor(index, count);
    const words = axis.label.split(' ');
    const lines = words.length === 2 ? words : [axis.label];
    // The lines and the score under them. Above the centre the block ends at the rim; below it,
    // it starts there; at the sides it is centred on its spoke.
    const block = (lines.length + 1) * LINE;
    const top =
      anchor === 'middle' ? (at.y < cy ? at.y - block + 10 : at.y + 12) : at.y - block / 2 + 11;
    return { at, anchor, lines, top, bottom: top + block - LINE };
  };

  const show = (axis: RadarAxis, index: number): void => {
    const label = labelOf(axis, index);
    // Under the label, so the tooltip covers neither the score it explains nor the shape.
    setTooltip({
      left: Math.max(0, Math.min(label.at.x - TOOLTIP_WIDTH / 2, width - TOOLTIP_WIDTH)),
      top: label.bottom + 10,
      title: axis.label,
      rows: [
        { name: axis.value === null ? 'no score' : valueColumn.toLowerCase(), value: axis.display },
      ],
      note: axis.note,
    });
    onActive?.(axis.key);
  };
  const hide = (): void => {
    setTooltip(null);
    onActive?.(null);
  };

  return (
    <ChartFigure
      title={title}
      subtitle={subtitle}
      series={[]}
      table={{
        columns: ['Measure', valueColumn],
        rows: axes.map((a) => [a.label, a.display]),
      }}
      summary={summary}
      tooltip={tooltip}
      testId={testId}
    >
      <div ref={ref} className="pb-chart-canvas">
        <svg
          className="pb-chart-svg pb-radar"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title}
        >
          <g className="pb-radar-web" aria-hidden="true">
            {RINGS.map((share) => (
              <polygon
                key={share}
                points={radarRing(count, share, radius, cx, cy)}
                className={share === 1 ? 'pb-radar-rim' : 'pb-radar-ring'}
              />
            ))}
            {RINGS.map((share) => {
              const at = radarRingLabel(count, share, radius, cx, cy);
              return (
                <text
                  key={share}
                  x={at.x}
                  y={at.y + 3}
                  textAnchor="middle"
                  className="pb-radar-ring-label"
                >
                  {share * 100}
                </text>
              );
            })}
          </g>
          <g
            className="pb-radar-shape"
            style={{ transformOrigin: `${cx}px ${cy}px` }}
            aria-hidden="true"
          >
            {shape.area === '' ? null : (
              <path d={shape.area} className="pb-radar-area" style={{ fill: color }} />
            )}
            {shape.outline === '' ? null : (
              <path d={shape.outline} className="pb-radar-outline" style={{ stroke: color }} />
            )}
          </g>
          {axes.map((axis, index) => {
            const rim = radarPoint(index, count, 100, radius, cx, cy);
            const { at, anchor, lines, top } = labelOf(axis, index);
            const point =
              axis.value === null ? null : radarPoint(index, count, axis.value, radius, cx, cy);
            const active = activeKey === axis.key;
            return (
              <g
                key={axis.key}
                tabIndex={0}
                role="img"
                aria-label={
                  axis.value === null
                    ? `${axis.label}: no score${axis.note === undefined ? '' : `. ${axis.note}`}`
                    : `${axis.label}: ${axis.display} of 100${axis.note === undefined ? '' : `. ${axis.note}`}`
                }
                className={`pb-chart-mark pb-radar-axis${active ? ' is-active' : ''}${axis.value === null ? ' is-missing' : ''}`}
                style={{ '--pb-radar-i': index } as CSSProperties}
                data-axis={axis.key}
                onPointerEnter={() => show(axis, index)}
                onPointerLeave={hide}
                onFocus={() => show(axis, index)}
                onBlur={hide}
              >
                <line x1={cx} y1={cy} x2={rim.x} y2={rim.y} className="pb-radar-spoke" />
                <line x1={cx} y1={cy} x2={rim.x} y2={rim.y} className="pb-radar-reach" />
                <text x={at.x} y={top} textAnchor={anchor} className="pb-radar-label">
                  {lines.map((line, i) => (
                    <tspan key={line} x={at.x} dy={i === 0 ? 0 : LINE}>
                      {line}
                    </tspan>
                  ))}
                  <tspan x={at.x} dy={LINE} className="pb-radar-score">
                    {axis.display}
                  </tspan>
                </text>
                {point === null ? null : (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={active ? 6 : 4}
                    className="pb-radar-point"
                    style={{ fill: color }}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}
