import type { ReactNode } from 'react';
import { linearScale } from './scale.js';

/**
 * A small trend under a key figure (64 by 20): the line in the de-emphasis tone with the latest
 * period marked in the accent. The line draws in once and the mark follows it (charts.css); the
 * path's length is 1, so the drawing needs no measuring.
 */
export function Sparkline({ values, label }: { values: number[]; label: string }): ReactNode {
  const w = 64;
  const h = 20;
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) return null;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const y = linearScale(lo, hi === lo ? lo + 1 : hi, h - 3, 3);
  const x = (i: number) => 3 + (i / (points.length - 1)) * (w - 6);
  const d = `M${points.map((v, i) => `${x(i)} ${y(v)}`).join('L')}`;
  const last = points[points.length - 1] ?? lo;
  return (
    <svg
      className="pb-sparkline"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
    >
      <path
        className="pb-sparkline-line"
        d={d}
        pathLength={1}
        fill="none"
        stroke="var(--pb-chart-muted)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        className="pb-sparkline-dot"
        cx={x(points.length - 1)}
        cy={y(last)}
        r={2.5}
        fill="var(--pb-brand-accent)"
      />
    </svg>
  );
}
