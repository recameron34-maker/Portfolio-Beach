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
import { formatDate, labelOf } from '../../lib/format.js';
import { watchFlagLabel } from '../../lib/labels.js';

type Severity = 'all' | 'bad' | 'watch';

const SEVERITY_LABELS: Record<Severity, string> = {
  all: 'All',
  bad: 'Needs action',
  watch: 'Watch',
};

/** Readable names for the config keys; an unknown key shows as itself. */
const THRESHOLD_LABELS: Record<string, string> = {
  netDebtToEbitdaMax: 'Net debt / EBITDA, maximum',
  ebitdaYoYDeclinePct: 'EBITDA decline year on year',
  markdownPct: 'Markdown against the prior Locked mark',
  missingFinancialsDays: 'Days without approved financials',
  maturityWithinMonths: 'Maturity within (months)',
};

const needsAction = (item: WatchlistItem): boolean => item.flags.some((f) => f.severity === 'bad');

function isSeverity(value: string): value is Severity {
  return value === 'all' || value === 'bad' || value === 'watch';
}

function FlaggedTable({ items }: { items: WatchlistItem[] }): ReactNode {
  return (
    <TableWrap label="Flagged positions">
      <table className="pb-table" aria-label="Flagged positions">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company</th>
            <th>Vehicle</th>
            <th>Deal type</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.investmentId}>
              <td>
                <span className="pb-key">{item.investmentNumber}</span>
              </td>
              <td>
                <Link to="/portfolio/$id" params={{ id: item.investmentId }}>
                  {item.companyName}
                </Link>
              </td>
              <td>{item.vehicleName}</td>
              <td>{labelOf(item.dealType)}</td>
              <td>
                <ul className="pb-flag-list">
                  {item.flags.map((f) => (
                    <li key={f.code}>
                      <Badge tone={f.severity}>{watchFlagLabel(f.code)}</Badge>
                      <span className="pb-meta">{f.message}</span>
                    </li>
                  ))}
                </ul>
              </td>
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
      <div className="pb-tiles" data-testid="watchlist-tiles">
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
        <StatTile
          label="Flagged positions"
          value={String(data.items.length)}
          hint={`of ${total} active positions`}
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
        <SectionHeader aside="Percentages are decimals (0.15 = 15%)">
          Thresholds (config/definitions.json)
        </SectionHeader>
        <KeyValueTable
          label="Thresholds (config/definitions.json)"
          rows={Object.entries(data.thresholds).map(([key, value]) => ({
            label: THRESHOLD_LABELS[key] ?? key,
            value: (
              <>
                {String(value)} <span className="pb-key">{key}</span>
              </>
            ),
          }))}
        />
        <p className="pb-meta">
          Thresholds change in configuration, never in code; every flag above cites the limit it was
          tested against.
        </p>
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
