import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DataLine16Regular, Table16Regular } from '@fluentui/react-icons';
import { MOTION, useReducedMotion } from '../motion.js';
import { TableWrap } from '../ui.js';

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
  /** A sentence under the rows: what a figure was worked out from, say. */
  note?: string | undefined;
}

/**
 * Where the browser cannot list a chart's running animations (tests), the entrance is taken to
 * be over after the longest one: a line drawing, then its end marker fading in.
 */
const ENTRANCE_MS = MOTION.draw + MOTION.base + MOTION.slow;

/**
 * Chart container: title, legend for two or more series, a table view of the same data
 * (the accessible twin, docs/12) and a tooltip layer. The SVG child is decorative for
 * assistive technology; the summary and the table carry the content. When the chart is the only
 * thing in its section, its title is the section's heading (`heading`): an h2, so a screen reader
 * moving by headings still finds the section. When the section's own title already names the
 * chart, `hideCaption` keeps the title for the figure's name and the table's name only.
 *
 * The entrance (charts.css, docs/06 section 5): once the canvas has its real width (`measured`)
 * the figure carries `data-entering` until its marks have drawn or grown in, then never again
 * while it stays mounted, so "Show table", a filter or a sort never replays it. Under reduced
 * motion it is never set. The view the reader swaps in fades in; the first view does not.
 */
export function ChartFigure({
  title,
  heading = false,
  hideCaption = false,
  subtitle,
  series,
  table,
  summary,
  tooltip,
  testId,
  measured = false,
  note,
  children,
}: {
  title: string;
  heading?: boolean | undefined;
  /** The section's title names the chart: the title is kept for screen readers and the table. */
  hideCaption?: boolean | undefined;
  subtitle?: string | undefined;
  series: SeriesKey[];
  table: TableTwin;
  summary: string;
  tooltip?: TooltipState | null | undefined;
  testId?: string | undefined;
  /** The canvas has reported its real width: the entrance may play. */
  measured?: boolean | undefined;
  /** A line under the chart about how it is drawn (a mark held at the axis edge, say). */
  note?: string | undefined;
  children: ReactNode;
}): ReactNode {
  const [showTable, setShowTable] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<'waiting' | 'entering' | 'done'>('waiting');
  const figure = useRef<HTMLElement>(null);
  const id = useId();
  // Decided while rendering, so the first frame at the real width is already the first frame of
  // the entrance: the finished chart is never painted and then taken away to be drawn.
  if (phase === 'waiting' && (measured || reduced)) setPhase(reduced ? 'done' : 'entering');
  if (phase === 'entering' && reduced) setPhase('done');

  useEffect(() => {
    if (phase !== 'entering') return undefined;
    let alive = true;
    const finish = (): void => {
      if (alive) setPhase('done');
    };
    const el = figure.current;
    if (el === null || typeof el.getAnimations !== 'function') {
      const timer = setTimeout(finish, ENTRANCE_MS);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }
    // Every mark's animation, settled: finished, or cancelled by the table view or the setting.
    const running = el
      .getAnimations({ subtree: true })
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished);
    void Promise.allSettled(running).then(finish);
    return () => {
      alive = false;
    };
  }, [phase]);

  const toggle = (): void => {
    setSwapped(true);
    setShowTable((v) => !v);
  };
  // Before the real width is known, the canvas waits unseen rather than show a chart drawn at the
  // fallback width that would then be taken away and drawn again.
  const waiting = phase === 'waiting' && typeof ResizeObserver !== 'undefined';
  const titleClass = hideCaption ? 'pb-chart-title pb-visually-hidden' : 'pb-chart-title';
  return (
    <figure
      ref={figure}
      className="pb-chart"
      data-testid={testId}
      aria-labelledby={`${id}-title`}
      data-entering={phase === 'entering' ? '' : undefined}
      data-waiting={waiting ? '' : undefined}
    >
      <figcaption className={hideCaption ? 'pb-chart-caption is-hidden' : 'pb-chart-caption'}>
        <div className="pb-chart-heading">
          {heading ? (
            <h2 id={`${id}-title`} className={titleClass}>
              {title}
            </h2>
          ) : (
            <span id={`${id}-title`} className={titleClass}>
              {title}
            </span>
          )}
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
            onClick={toggle}
          >
            {showTable ? (
              <DataLine16Regular aria-hidden="true" />
            ) : (
              <Table16Regular aria-hidden="true" />
            )}
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </figcaption>
      <p className="pb-visually-hidden">{summary}</p>
      {showTable ? (
        <div className={swapped ? 'pb-swap-in' : undefined}>
          <TableWrap label={`${title}, as a table`}>
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
          </TableWrap>
        </div>
      ) : (
        <div className={swapped ? 'pb-chart-wrap pb-swap-in' : 'pb-chart-wrap'}>
          {children}
          {note !== undefined ? <p className="pb-chart-note">{note}</p> : null}
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
              {tooltip.note !== undefined ? (
                <div className="pb-chart-tooltip-note">{tooltip.note}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
