import type { ReactNode } from 'react';
import { linearScale } from './scale.js';

/** Twelve-point trend in the de-emphasis tone with the current period marked in the accent. */
export function Sparkline({ values, label }: { values: number[]; label: string }): ReactNode {
  const w = 84;
  const h = 24;
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) return null;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const y = linearScale(lo, hi === lo ? lo + 1 : hi, h - 4, 4);
  const x = (i: number) => 4 + (i / (points.length - 1)) * (w - 8);
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
        d={d}
        fill="none"
        stroke="var(--pb-chart-muted)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(points.length - 1)} cy={y(last)} r={3} fill="var(--pb-brand-accent)" />
    </svg>
  );
}
