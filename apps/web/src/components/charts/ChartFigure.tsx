import { useId, useState } from 'react';
import type { ReactNode } from 'react';

export interface SeriesKey {
  name: string;
  color: string;
}

export interface TableTwin {
  columns: string[];
  rows: string[][];
}

export interface TooltipState {
  left: number;
  top: number;
  title: string;
  rows: { name: string; value: string; color?: string | undefined }[];
}

/**
 * Chart container: title, legend for two or more series, a table view of the same data
 * (the accessible twin, docs/12) and a tooltip layer. The SVG child is decorative for
 * assistive technology; the summary and the table carry the content.
 */
export function ChartFigure({
  title,
  subtitle,
  series,
  table,
  summary,
  tooltip,
  testId,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  series: SeriesKey[];
  table: TableTwin;
  summary: string;
  tooltip?: TooltipState | null | undefined;
  testId?: string | undefined;
  children: ReactNode;
}): ReactNode {
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  return (
    <figure className="pb-chart" data-testid={testId} aria-labelledby={`${id}-title`}>
      <figcaption className="pb-chart-caption">
        <div className="pb-chart-heading">
          <span id={`${id}-title`} className="pb-chart-title">
            {title}
          </span>
          {subtitle !== undefined ? <span className="pb-chart-subtitle">{subtitle}</span> : null}
        </div>
        <div className="pb-chart-tools">
          {series.length >= 2 ? (
            <ul className="pb-chart-legend" aria-label="Legend">
              {series.map((s) => (
                <li key={s.name}>
                  <span
                    className="pb-chart-swatch"
                    style={{ background: s.color }}
                    aria-hidden="true"
                  />
                  {s.name}
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="pb-chart-toggle"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </figcaption>
      <p className="pb-visually-hidden">{summary}</p>
      {showTable ? (
        <table className="pb-table pb-chart-table" aria-label={`${title}, as a table`}>
          <thead>
            <tr>
              {table.columns.map((c, i) => (
                <th key={c} className={i === 0 ? undefined : 'num'}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr key={`${r[0] ?? ''}-${ri}`}>
                {r.map((cell, ci) => (
                  <td key={`${ci}-${cell}`} className={ci === 0 ? undefined : 'num'}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pb-chart-wrap">
          {children}
          {tooltip !== null && tooltip !== undefined ? (
            <div
              className="pb-chart-tooltip"
              role="tooltip"
              style={{ left: tooltip.left, top: tooltip.top }}
            >
              <div className="pb-chart-tooltip-title">{tooltip.title}</div>
              {tooltip.rows.map((r) => (
                <div key={r.name} className="pb-chart-tooltip-row">
                  {r.color !== undefined ? (
                    <span
                      className="pb-chart-key"
                      style={{ background: r.color }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="pb-chart-tooltip-value">{r.value}</span>
                  <span className="pb-chart-tooltip-name">{r.name}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
