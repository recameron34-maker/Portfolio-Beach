import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { Watchlist, WatchlistItem } from '@pb/contracts';
import { PORTFOLIO_TABS } from '../../app/nav.js';
import { watchlistQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMultiple, formatPct, labelOf, plural } from '../../lib/format.js';
import { watchFlagLabel } from '../../lib/labels.js';
import { useNarrowScreen } from '../../lib/media.js';
import { balanceTiles } from '../../lib/tiles.js';

type Severity = 'all' | 'bad' | 'watch';

const SEVERITY_LABELS: Record<Severity, string> = {
  all: 'All',
  bad: 'Needs action',
  watch: 'Watch',
};

/** Readable names for the thresholds; an unknown one shows as it came. */
const THRESHOLD_LABELS: Record<string, string> = {
  netDebtToEbitdaMax: 'Net debt / EBITDA, maximum',
  ebitdaYoYDeclinePct: 'EBITDA decline year on year',
  markdownPct: 'Markdown against the prior Locked mark',
  missingFinancialsDays: 'Without approved financials for',
  maturityWithinMonths: 'Maturity within',
};

/** The decimals a plain decimal carries ("6.25" has two); null for any other spelling. */
function decimalsOf(text: string): number | null {
  const m = /^\d+(?:\.(\d+))?$/.exec(text);
  return m === null ? null : (m[1]?.length ?? 0);
}

/**
 * A threshold in the reader's units, from the unit its name carries: a share as a percentage,
 * months and days as words, the leverage limit as a multiple. Any other value shows as recorded.
 * A limit is never rounded: the flags were tested against the value as configured, so 6.25 reads
 * "6.25x" and 0.1275 reads "12.75%". One decimal is the least shown ("6.0x", "15.0%").
 */
function thresholdText(key: string, value: number | string): string {
  const text = String(value);
  const decimals = decimalsOf(text);
  if (key.endsWith('Pct'))
    return decimals === null ? text : formatPct(text, Math.max(1, decimals - 2));
  if (key === 'netDebtToEbitdaMax')
    return decimals === null ? text : decimals <= 1 ? formatMultiple(text) : `${text}x`;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (Number.isInteger(n) && key.endsWith('Months')) return plural(n, 'month');
  if (Number.isInteger(n) && key.endsWith('Days')) return plural(n, 'day');
  return text;
}

const needsAction = (item: WatchlistItem): boolean => item.flags.some((f) => f.severity === 'bad');

function isSeverity(value: string): value is Severity {
  return value === 'all' || value === 'bad' || value === 'watch';
}

function PositionCell({ item }: { item: WatchlistItem }): ReactNode {
  return (
    <>
      <Link to="/portfolio/$id" params={{ id: item.investmentId }}>
        {item.companyName}
      </Link>
      <span className="pb-cell-sub">
        {[item.investmentNumber, item.vehicleName, labelOf(item.dealType)].join(' \u00B7 ')}
      </span>
    </>
  );
}

function FlagList({ item }: { item: WatchlistItem }): ReactNode {
  return (
    <ul className="pb-flag-list">
      {item.flags.map((f) => (
        <li key={f.code}>
          <Badge tone={f.severity}>{watchFlagLabel(f.code)}</Badge>
          <span className="pb-flag-message">{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The flagged positions in two columns: the position (the company, then its number, vehicle and
 * deal type on a second line) and its flags (each a dot, the flag in words, then the message). On
 * a phone the flags sit under the position in one column, still one table.
 */
function FlaggedTable({ items }: { items: WatchlistItem[] }): ReactNode {
  const narrow = useNarrowScreen();
  return (
    <TableWrap label="Flagged positions">
      <table className="pb-table pb-watchlist" aria-label="Flagged positions">
        <thead>
          <tr>
            {narrow ? (
              <th>Position and flags</th>
            ) : (
              <>
                <th>Position</th>
                <th>Flags</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.investmentId}>
              {narrow ? (
                <td>
                  <PositionCell item={item} />
                  <FlagList item={item} />
                </td>
              ) : (
                <>
                  <td className="pb-watchlist-position">
                    <PositionCell item={item} />
                  </td>
                  <td>
                    <FlagList item={item} />
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function WatchlistBody({ data }: { data: Watchlist }): ReactNode {
  const [severity, setSeverity] = useState<Severity>('all');
  const shown =
    severity === 'all'
      ? data.items
      : data.items.filter((i) => (severity === 'bad' ? needsAction(i) : !needsAction(i)));
  const total = data.items.length + data.counts.clear;
  return (
    <>
      <div ref={balanceTiles} className="pb-tiles" data-testid="watchlist-tiles">
        <StatTile
          label="Needs action"
          value={String(data.counts.bad)}
          hint="At least one flag needs action"
          tone={data.counts.bad > 0 ? 'bad' : undefined}
        />
        <StatTile
          label="Watch"
          value={String(data.counts.watch)}
          hint="Watch-level flags only"
          tone={data.counts.watch > 0 ? 'watch' : undefined}
        />
        <StatTile label="Clear" value={String(data.counts.clear)} hint="No flags" tone="good" />
        {/* The hint is the only place the page says how many active positions were tested. */}
        <StatTile
          label="Flagged positions"
          value={String(data.items.length)}
          hint={`of ${plural(total, 'active position')}`}
        />
      </div>
      <Card>
        <SectionHeader aside={`${shown.length} of ${data.items.length} flagged`}>
          Flagged positions
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="watchlist-severity">Severity</Label>
            <Dropdown
              id="watchlist-severity"
              value={SEVERITY_LABELS[severity]}
              selectedOptions={[severity]}
              onOptionSelect={(_e, d) => {
                if (d.optionValue !== undefined && isSeverity(d.optionValue)) {
                  setSeverity(d.optionValue);
                }
              }}
            >
              {(Object.keys(SEVERITY_LABELS) as Severity[]).map((key) => (
                <Option key={key} value={key}>
                  {SEVERITY_LABELS[key]}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {shown.length === 0 ? (
          <EmptyState
            title={data.items.length === 0 ? 'Nothing flagged' : 'Nothing at this severity'}
            detail={
              data.items.length === 0
                ? 'No active position breaches a monitoring threshold.'
                : 'Choose another severity to see the other flagged positions.'
            }
          />
        ) : (
          <FlaggedTable items={shown} />
        )}
      </Card>
      <Card>
        <SectionHeader>Monitoring thresholds</SectionHeader>
        <KeyValueTable
          label="Monitoring thresholds"
          rows={Object.entries(data.thresholds).map(([key, value]) => ({
            label: THRESHOLD_LABELS[key] ?? key,
            value: thresholdText(key, value),
          }))}
        />
        <p className="pb-meta">Each flag above names the limit it was tested against.</p>
      </Card>
    </>
  );
}

export function WatchlistPage(): ReactNode {
  const q = useQuery({ ...watchlistQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton tiles={4} rows={4} />;
  return (
    <>
      <PageHeader
        title="Watchlist"
        meta={
          q.data !== undefined
            ? `As of ${formatDate(q.data.asOf)}. Active positions tested against the monitoring thresholds.`
            : 'Active positions tested against the monitoring thresholds.'
        }
      />
      <TabNav label="Portfolio" items={PORTFOLIO_TABS} />
      {q.isError ? (
        <UnavailableState error={q.error} subject="The watchlist" />
      ) : (
        <WatchlistBody data={q.data} />
      )}
    </>
  );
}
