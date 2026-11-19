import { Fragment, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { previewMode } from '../app/env.js';
import { MISSING } from '../lib/format.js';
import { useNarrowScreen } from '../lib/media.js';
import { tabsFor } from '../lib/role-focus.js';
import { useRoleFocus } from '../lib/role-focus-context.js';

/**
 * Section title (docs/06 section 2): an h2 in sentence case at the section title size, with an
 * optional aside on the right (a date, a count, a short note). Commands for the section go in
 * `actions`, beside the heading rather than inside it, so a button never becomes part of the
 * heading's name.
 */
export function SectionHeader({
  children,
  aside,
  actions,
}: {
  children: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  const heading = (
    <h2 className="pb-section-header">
      <span>{children}</span>
      {aside !== undefined ? <span className="pb-section-aside">{aside}</span> : null}
    </h2>
  );
  if (actions === undefined) return heading;
  return (
    <div className="pb-section-head">
      {heading}
      <div className="pb-section-actions">{actions}</div>
    </div>
  );
}

/** A title inside a section, one step below the section title. */
export function Subhead({ children }: { children: ReactNode }): ReactNode {
  return <h3 className="pb-subhead">{children}</h3>;
}

/**
 * A section of a page: a hairline rule above its content, no frame (docs/06 section 2). `panel`
 * frames the few things that stand apart from the page, such as a form opened in place. `id`
 * names a section a row of in-page links jumps to (JumpLinks).
 */
export function Card({
  children,
  panel = false,
  tone,
  testId,
  id,
}: {
  children: ReactNode;
  panel?: boolean;
  tone?: 'error' | undefined;
  testId?: string;
  id?: string | undefined;
}): ReactNode {
  const className = ['pb-card', panel ? 'is-panel' : '', tone === 'error' ? 'pb-card-error' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <section className={className} data-testid={testId} id={id}>
      {children}
    </section>
  );
}

/** Why a count tile shows the missing placeholder when the list behind it is only its first page. */
export const PARTIAL_PAGE_HINT = 'Not calculable: more rows than one page holds';

/**
 * A count of rows in a list. When the list is only its first page the count would be of the page,
 * not the list, so the tile shows the missing placeholder instead (CLAUDE.md rule 10).
 */
export function CountTile({
  label,
  count,
  hint,
  tone,
  partial,
}: {
  label: string;
  count: number;
  hint: string;
  tone?: 'good' | 'watch' | 'bad' | undefined;
  partial: boolean;
}): ReactNode {
  return partial ? (
    <StatTile label={label} value={MISSING} hint={PARTIAL_PAGE_HINT} />
  ) : (
    <StatTile label={label} value={String(count)} hint={hint} tone={tone} />
  );
}

/**
 * One cell of a figures strip: a label, the key figure in ink, optionally a small figure (a
 * sparkline) beside it, and a hint. A tone shows as a dot before the label, never on the figure,
 * and a zero carries no dot (data-zero). Plain spans: Fluent Text would inject its own sizes.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
  figure,
  wide = false,
  title,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: 'good' | 'watch' | 'bad' | undefined;
  figure?: ReactNode;
  /** Spans two grid columns, for the headline figure of a row of tiles. */
  wide?: boolean;
  /** How the figure is worked out, shown under the pointer ("Distributions / invested"). */
  title?: string | undefined;
}): ReactNode {
  const missing = value === MISSING || value === 'NM';
  const number = (
    <span className={missing ? 'pb-stat-value is-missing' : 'pb-stat-value'}>{value}</span>
  );
  return (
    <div
      className={wide ? 'pb-stat-tile is-wide' : 'pb-stat-tile'}
      role="group"
      aria-label={label}
      title={title}
      data-tone={tone}
      data-zero={value === '0' ? '' : undefined}
    >
      <span className="pb-stat-label">{label}</span>
      {figure !== undefined && figure !== null ? (
        <span className="pb-stat-row">
          {number}
          {figure}
        </span>
      ) : (
        number
      )}
      {hint !== undefined ? <span className="pb-stat-hint">{hint}</span> : null}
    </div>
  );
}

/** A right-aligned numeric table cell; the missing placeholder and NM render muted. */
export function NumCell({
  children,
  className,
}: {
  children: string;
  /** Added after the cell's own classes (a group's first column, say). */
  className?: string | undefined;
}): ReactNode {
  const missing = children === MISSING || children === 'NM';
  const own = missing ? 'num is-missing' : 'num';
  return <td className={className === undefined ? own : `${own} ${className}`}>{children}</td>;
}

export function AiDraftBadge(): ReactNode {
  return (
    <span className="pb-ai-draft" title="Generated by an assistant and not yet approved">
      AI draft
    </span>
  );
}

export function ErrorState({
  title,
  detail,
}: {
  title: string;
  detail?: string | undefined;
}): ReactNode {
  return (
    <Card tone="error" testId="error-state">
      <SectionHeader>{title}</SectionHeader>
      {detail !== undefined ? <p>{detail}</p> : null}
    </Card>
  );
}

/**
 * The trail of where a record's page sits (docs/06 section 2): each earlier step a link, in a
 * navigation named Breadcrumb. PageHeader draws it over the title; a page that cannot show its
 * record (not found) still shows the way back with it alone.
 */
export function Breadcrumbs({
  items,
}: {
  items: readonly { label: string; to?: string | undefined }[];
}): ReactNode {
  return (
    <nav aria-label="Breadcrumb" className="pb-crumbs">
      <ol>
        {items.map((c) => (
          <li key={`${c.label}|${c.to ?? ''}`}>
            {c.to !== undefined ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Page header (docs/06 section 2): on a record's page, the trail of where it sits (`crumbs`, each
 * earlier step a link); the title, with the page's actions on the right; and one meta line (the
 * as-of date, whose view it is), which wraps rather than hides anything. `titleAside` sits on the
 * title's line after the heading, outside it (a record's identifier and its state), so the
 * heading's name stays the record's name.
 */
export function PageHeader({
  title,
  titleAside,
  meta,
  actions,
  crumbs,
  testId,
}: {
  title: ReactNode;
  titleAside?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  crumbs?: { label: string; to?: string }[] | undefined;
  testId?: string | undefined;
}): ReactNode {
  return (
    <div className="pb-banner" data-testid={testId}>
      {crumbs !== undefined && crumbs.length > 0 ? <Breadcrumbs items={crumbs} /> : null}
      {titleAside === undefined ? (
        <h1>{title}</h1>
      ) : (
        <div className="pb-banner-title">
          <h1>{title}</h1>
          <span className="pb-banner-title-aside">{titleAside}</span>
        </div>
      )}
      {meta !== undefined ? <span className="pb-meta">{meta}</span> : null}
      {actions !== undefined ? <span className="pb-banner-actions">{actions}</span> : null}
    </div>
  );
}

/**
 * Secondary navigation inside an area (tabs). Paths are absolute so hash and browser history both
 * work. A tab may carry a search (the filters two tabs share); it does not decide which tab is
 * the current one. The tabs a role works in most come first for that role; none is left out. On a
 * phone the tabs are one row that scrolls, so the current tab is brought into view when it opens.
 */
export function TabNav({
  items,
  label,
  className,
}: {
  items: {
    to: string;
    label: string;
    exact?: boolean | undefined;
    search?: Record<string, string | number> | undefined;
  }[];
  label: string;
  /** Added after pb-tabs, so the row keeps the tabs' look and stays out of the page's entrance. */
  className?: string | undefined;
}): ReactNode {
  // The role's order for this row, when its configuration gives one (config/role_focus.json).
  const ordered = tabsFor(items, useRoleFocus());
  const narrow = useNarrowScreen();
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = row.current;
    if (!narrow || nav === null) return undefined;
    // Which ends of the row hide tabs, for the stylesheet: an end that hides one fades out, so a
    // tab cut off at either edge always shows that more lie beyond it.
    const mark = (): void => {
      const hidden = nav.scrollWidth - nav.clientWidth;
      nav.toggleAttribute('data-more-before', nav.scrollLeft > 1);
      nav.toggleAttribute('data-more-after', nav.scrollLeft < hidden - 1);
    };
    const current = nav.querySelector('[aria-current="page"]');
    if (current !== null) {
      // The current tab to the middle of the row, so the tabs on both sides of it show. Only the
      // row scrolls: scrollIntoView would also scroll the page whenever the row is out of sight,
      // as when a window is narrowed and widened again.
      const tab = current.getBoundingClientRect();
      const edge = nav.getBoundingClientRect();
      nav.scrollLeft += tab.left + tab.width / 2 - (edge.left + edge.width / 2);
    }
    mark();
    nav.addEventListener('scroll', mark, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(mark);
    resized?.observe(nav);
    return () => {
      nav.removeEventListener('scroll', mark);
      resized?.disconnect();
      nav.removeAttribute('data-more-before');
      nav.removeAttribute('data-more-after');
    };
  }, [narrow]);
  useEffect(() => {
    const nav = row.current;
    if (nav === null || typeof IntersectionObserver === 'undefined') return undefined;
    // A row the stylesheet keeps in view under the top bar (the deal workspace's) says when it is
    // held there, so its rule can darken: it is held when its top has reached its sticky offset,
    // which an observer whose top edge sits 1px below that offset sees as the row crossing it.
    const style = getComputedStyle(nav);
    if (style.position !== 'sticky') return undefined;
    const offset = Number.parseFloat(style.top) || 0;
    const seen = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined || entry.rootBounds === null) return;
        nav.toggleAttribute(
          'data-stuck',
          entry.intersectionRatio < 1 && entry.boundingClientRect.top < entry.rootBounds.top,
        );
      },
      { rootMargin: `-${offset + 1}px 0px 0px 0px`, threshold: [0, 1] },
    );
    seen.observe(nav);
    return () => {
      seen.disconnect();
      nav.removeAttribute('data-stuck');
    };
  }, [narrow]);
  return (
    <nav
      className={className === undefined ? 'pb-tabs' : `pb-tabs ${className}`}
      aria-label={label}
      ref={row}
    >
      {ordered.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          // A tab names its route by a plain path, so its search has no single route type.
          {...(t.search === undefined ? {} : { search: t.search as never })}
          activeOptions={{ exact: t.exact ?? false, includeSearch: false }}
          activeProps={{ 'aria-current': 'page' }}
          resetScroll={false}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export type Tone = 'neutral' | 'good' | 'watch' | 'bad' | 'brand' | 'accent';

/**
 * A state as a small dot and a word, never colour alone and never a pill (docs/06 section 2). The
 * dot carries the tone; the word stays in ink unless the state needs its own (watch, bad). plain
 * drops the dot: a category is plain text, not a state.
 */
export function Badge({
  tone = 'neutral',
  plain = false,
  children,
}: {
  tone?: Tone;
  plain?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <span className={`pb-badge pb-badge-${tone}${plain ? ' pb-badge-plain' : ''}`}>
      <span className="pb-badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * The frame every table sits in. A table wider than its section (a phone) scrolls sideways inside
 * it, and the frame takes keyboard focus so it can be scrolled without a pointer (WCAG 2.1.1).
 * It is positioned, so visually hidden text inside the table (absolutely positioned) scrolls and
 * clips with the table instead of widening the page. The label is the table's own label. `tall`
 * holds a long table in a region of limited height whose header stays in view; `busy` says the
 * rows are being replaced (aria-busy), and the frame dims while they are. The frame marks, for the
 * stylesheet, when its table is wider than it (`data-overflow-x`: the held first column's edge)
 * and when a tall region has rows below its foot (`data-more-below`: the rule at the foot), the
 * way TabNav marks the ends of its row.
 */
export function TableWrap({
  label,
  tall = false,
  busy = false,
  testId,
  children,
}: {
  label: string;
  tall?: boolean;
  busy?: boolean;
  testId?: string | undefined;
  children: ReactNode;
}): ReactNode {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = frame.current;
    if (wrap === null) return undefined;
    const mark = (): void => {
      wrap.toggleAttribute('data-overflow-x', wrap.scrollWidth > wrap.clientWidth + 1);
      wrap.toggleAttribute(
        'data-more-below',
        tall && wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 1,
      );
    };
    mark();
    wrap.addEventListener('scroll', mark, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(mark);
    resized?.observe(wrap);
    // The table inside changes size when its rows change (a filter, a page of results).
    if (wrap.firstElementChild !== null) resized?.observe(wrap.firstElementChild);
    return () => {
      wrap.removeEventListener('scroll', mark);
      resized?.disconnect();
    };
  });
  return (
    <div
      ref={frame}
      className={tall ? 'pb-table-wrap is-tall' : 'pb-table-wrap'}
      role="region"
      aria-label={label}
      aria-busy={busy ? true : undefined}
      tabIndex={0}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * Label and value pairs in two or four columns; values keep tabular figures. On a phone each pair
 * takes its own row, so nothing scrolls sideways. It stays a table at every width.
 */
export function KeyValueTable({
  rows,
  label,
  columns = 2,
}: {
  rows: { label: string; value: ReactNode }[];
  label: string;
  columns?: 1 | 2;
}): ReactNode {
  const perRow = useNarrowScreen() ? 1 : columns;
  const pairs: { label: string; value: ReactNode }[][] = [];
  for (let i = 0; i < rows.length; i += perRow) pairs.push(rows.slice(i, i + perRow));
  return (
    <TableWrap label={label}>
      <table className="pb-table pb-kv" aria-label={label}>
        <tbody>
          {pairs.map((pair, i) => (
            <tr key={i}>
              {pair.map((r) => (
                <Fragment key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}</td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** One row of a check list: what was checked, its result, why or where, and a command for it. */
export interface CheckRow {
  check: ReactNode;
  /** Draws a dot before the result; the result's words are the caller's, never added here. */
  tone?: Tone | undefined;
  result: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** The result is a sentence: it runs on across the detail column. */
  wide?: boolean | undefined;
}

/**
 * Checks and their results as one compact table (docs/06 section 2): Check, Result, Detail and,
 * when any row has one, a command at the end. A tone only draws the dot before the result, so a
 * page states exactly the result it states today; a row with no tone keeps the dot's room, so the
 * results line up. An empty detail stays blank. On a phone a command closes its row's detail
 * instead of taking a column, so the detail keeps room to read.
 */
export function CheckList({
  label,
  testId,
  rows,
}: {
  label: string;
  testId?: string | undefined;
  rows: CheckRow[];
}): ReactNode {
  const narrow = useNarrowScreen();
  const withActions = !narrow && rows.some((r) => r.action !== undefined);
  const inline = (r: CheckRow): ReactNode =>
    narrow && r.action !== undefined ? <span className="pb-check-command">{r.action}</span> : null;
  return (
    <TableWrap label={label} testId={testId}>
      <table className="pb-table pb-table-short pb-checks" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col" className="pb-checks-result-col">
              Result
            </th>
            <th scope="col">Detail</th>
            {withActions ? (
              <th scope="col">
                <span className="pb-visually-hidden">Command</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.check}</th>
              <td
                className={r.wide === true ? 'pb-check-cell is-wide' : 'pb-check-cell'}
                colSpan={r.wide === true ? 2 : undefined}
              >
                <div className="pb-check-result" data-tone={r.tone}>
                  <span className="pb-check-dot" aria-hidden="true" />
                  <div className="pb-check-value">{r.result}</div>
                </div>
                {r.wide === true ? inline(r) : null}
              </td>
              {r.wide === true ? null : (
                <td className="pb-check-detail">
                  {r.detail}
                  {inline(r)}
                </td>
              )}
              {withActions ? <td className="pb-checks-action">{r.action}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function Toolbar({ children, end }: { children: ReactNode; end?: ReactNode }): ReactNode {
  return (
    <div className="pb-toolbar">
      {children}
      {end !== undefined ? <div className="pb-toolbar-end">{end}</div> : null}
    </div>
  );
}

/** Label above a control inside a Toolbar. */
export function Field({ children }: { children: ReactNode }): ReactNode {
  return <div className="pb-field">{children}</div>;
}

/**
 * Nothing to show, said plainly, with the reason and optionally what would make it appear: a title
 * and its detail, left-aligned, with no frame and no mark.
 */
export function EmptyState({
  title,
  detail,
  testId,
}: {
  title: string;
  detail?: string | undefined;
  testId?: string | undefined;
}): ReactNode {
  return (
    <div className="pb-empty" data-testid={testId}>
      <p className="pb-empty-title">{title}</p>
      {detail !== undefined ? <p className="pb-empty-detail">{detail}</p> : null}
    </div>
  );
}

/**
 * Nothing to show inside a section, in one muted line: what is missing, then why or what would
 * fill it. A section keeps its title above it, so the line needs no title of its own.
 */
export function EmptyLine({
  title,
  detail,
  testId,
}: {
  title: string;
  detail?: string | undefined;
  testId?: string | undefined;
}): ReactNode {
  return (
    <p className="pb-meta pb-empty-line" data-testid={testId}>
      <span className="pb-empty-line-title">{title}</span>
      {detail === undefined ? null : `. ${detail}`}
    </p>
  );
}

/**
 * A sentence on a quiet band with a dot in its tone (docs/06 section 2): info for what the reader
 * should know, good, watch or bad when it reports an outcome. No frame and no bar.
 */
export function Notice({
  tone = 'info',
  children,
  testId,
}: {
  tone?: 'info' | 'good' | 'watch' | 'bad';
  children: ReactNode;
  testId?: string | undefined;
}): ReactNode {
  return (
    <p
      className={tone === 'info' ? 'pb-notice' : `pb-notice pb-notice-${tone}`}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

/** One loading row: bars where a name and three figures will be. */
function SkeletonRow(): ReactNode {
  return (
    <div className="pb-skeleton-row">
      <div className="pb-skeleton-bar" />
      <div className="pb-skeleton-bar" />
      <div className="pb-skeleton-bar" />
      <div className="pb-skeleton-bar" />
    </div>
  );
}

/**
 * Page-level loading, in the shape of the page that replaces it: a title, a strip of figures and
 * rows. aria-busy, never role="status": the banner must stay the only status element on app pages.
 */
export function PageSkeleton({
  tiles = 0,
  rows = 3,
}: {
  tiles?: number;
  rows?: number;
}): ReactNode {
  return (
    <div className="pb-skeleton" aria-busy="true">
      <span className="pb-visually-hidden">Loading</span>
      <div className="pb-skeleton-bar is-title" />
      {tiles > 0 ? (
        <div className="pb-skeleton-tiles">
          {Array.from({ length: tiles }, (_, i) => (
            <div key={i} className="pb-skeleton-tile">
              <div className="pb-skeleton-bar" />
              <div className="pb-skeleton-bar" />
            </div>
          ))}
        </div>
      ) : null}
      <div className="pb-skeleton-rows">
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    </div>
  );
}

/** A list loading inside a section: rows of bars, busy, never role="status". */
export function RowsSkeleton({
  rows,
  label = 'Loading',
}: {
  rows: number;
  /** What a screen reader hears while the list loads ("Loading sign-in options"). */
  label?: string;
}): ReactNode {
  return (
    <div className="pb-skeleton pb-skeleton-rows" aria-busy="true">
      <span className="pb-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

/** Marks an action the static preview only simulates (docs/16: no server, nothing saved, nothing audited). */
export function SimulatedBadge(): ReactNode {
  if (!previewMode) return null;
  return (
    <span
      className="pb-simulated"
      title="Simulated in this preview: not saved, not audited, resets when the page reloads"
    >
      Simulated
    </span>
  );
}
