import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Button, Switch } from '@fluentui/react-components';
import { ArrowDownload16Regular } from '@fluentui/react-icons';
import type { ValueCreation, ValueCreationPosition } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { BridgeChart, ScatterChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMultiple,
  formatPct,
  irrDisplay,
  MISSING,
  plural,
} from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { useActionLog } from '../../lib/workflow.js';
import { csvRowCount, downloadText, exportResult } from '../monitoring/monitoring.js';
import { fetchValueCreationExport, valueCreationQuery } from './value-creation-queries.js';
import {
  canOpenEbitda,
  DEFAULT_SORT,
  exportFileName,
  formatSignedMoneyM,
  growthPoints,
  leftOutText,
  nextSort,
  portfolioBridgeSteps,
  positionsText,
  REASON_TEXT,
  sortPositions,
} from './value-creation.js';
import type { SortKey, SortState } from './value-creation.js';
import './analytics.css';

type Portfolio = ValueCreation['portfolio'];

/** The headline: our gain over the positions it is split for, and the three drivers it splits into. */
function HeadlineTiles({ portfolio }: { portfolio: Portfolio }): ReactNode {
  const g = portfolio.gainByDriver;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="value-creation-tiles">
      <StatTile
        wide
        label="Our gain"
        value={formatMoneyM(portfolio.gain)}
        hint={
          portfolio.positions === 0
            ? 'Not calculable: no position can be split by driver'
            : `NAV plus distributions less invested, ${positionsText(portfolio.positions)}`
        }
      />
      <StatTile
        label="EBITDA growth"
        value={formatSignedMoneyM(g?.ebitdaGrowth ?? null)}
        hint="Earnings growth at the entry multiple"
      />
      <StatTile
        label="Multiple expansion"
        value={formatSignedMoneyM(g?.multipleExpansion ?? null)}
        hint="Change in EV / EBITDA on current earnings"
      />
      <StatTile
        label="Debt paydown"
        value={formatSignedMoneyM(g?.debtPaydown ?? null)}
        hint="Fall in net debt since entry"
      />
    </div>
  );
}

/** The positions the split leaves out: a quiet count, the positions and their reasons on demand. */
function NotCalculableNote({ view }: { view: ValueCreation }): ReactNode {
  const left = view.positions.filter((p) => p.gainNotCalculable !== null);
  if (left.length === 0) return null;
  return (
    <details className="pb-analytics-details" data-testid="value-creation-not-calculable">
      <summary>
        {left.length === 1
          ? '1 position is not in this split'
          : `${left.length} positions are not in this split`}
      </summary>
      <ul className="pb-list">
        {left.map((p) => (
          <li key={p.id}>
            {p.companyName} ({p.investmentNumber}):{' '}
            {p.gainNotCalculable === null ? null : REASON_TEXT[p.gainNotCalculable]}
          </li>
        ))}
      </ul>
    </details>
  );
}

function BridgeCard({ view }: { view: ValueCreation }): ReactNode {
  const [open, setOpen] = useState(false);
  const { portfolio } = view;
  const steps = portfolioBridgeSteps(portfolio, open);
  const g = portfolio.gainByDriver;
  return (
    <Card testId="value-creation-bridge-card">
      <SectionHeader
        aside={portfolio.positions === 0 ? undefined : `Over ${positionsText(portfolio.positions)}`}
      >
        Value creation
      </SectionHeader>
      {steps === null || g === null ? (
        <EmptyState
          title="No position can be split by driver as of this date"
          detail="The split needs an approved entry snapshot, an approved quarter with positive EBITDA and a Locked valuation. The reasons are listed below, position by position."
        />
      ) : (
        <>
          <Toolbar>
            <Switch
              checked={open}
              disabled={!canOpenEbitda(g)}
              onChange={(_e, data) => setOpen(data.checked)}
              label="Open EBITDA growth into revenue growth and margin change"
            />
          </Toolbar>
          <BridgeChart
            title="Our gain by driver"
            subtitle="Invested capital to value now (NAV plus distributions)"
            steps={steps}
            kind="money"
            summary={`Our gain of ${formatMoneyM(portfolio.gain)} over ${positionsText(portfolio.positions)}: EBITDA growth ${formatSignedMoneyM(g.ebitdaGrowth)}, multiple expansion ${formatSignedMoneyM(g.multipleExpansion)} and debt paydown ${formatSignedMoneyM(g.debtPaydown)}, from ${formatMoneyM(portfolio.invested)} invested to ${formatMoneyM(portfolio.totalValue)} of value now.`}
            testId="value-creation-bridge"
          />
          <p className="pb-meta pb-analytics-note">
            Each position&apos;s gain is split by its company&apos;s bridge from the entry snapshot
            to the latest approved quarter: EBITDA growth at the entry multiple, then the change in
            the multiple, then the fall in net debt. A company whose equity value barely moved
            carries large shares, so its parts can be large against its gain.
          </p>
        </>
      )}
      <NotCalculableNote view={view} />
    </Card>
  );
}

function GrowthCard({ view }: { view: ValueCreation }): ReactNode {
  const { points, leftOut, seriesNames, ahead } = growthPoints(view.positions);
  return (
    <Card testId="value-creation-growth-card">
      <SectionHeader aside="Since entry, one mark per company">
        Valuation and earnings
      </SectionHeader>
      {points.length === 0 ? (
        <EmptyState
          title="No position has both figures"
          detail="The chart needs EBITDA growth since entry and the growth in our mark for a position."
        />
      ) : (
        <>
          <ScatterChart
            title="Valuation growth against EBITDA growth"
            subtitle="The dashed line is where the two are equal"
            points={points}
            xLabel="EBITDA growth since entry"
            yLabel="Growth in our mark"
            xKind="pct"
            yKind="pct"
            seriesNames={seriesNames}
            seriesLabel="Side of the line"
            equalLine
            summary={`Growth in our mark (gross MOIC less one) against the company's EBITDA growth since entry for ${plural(points.length, 'position')}; ${ahead} sit above the line where the two are equal.`}
            testId="value-creation-scatter"
          />
          <p className="pb-meta pb-analytics-note">
            {`${ahead} of ${plural(points.length, 'mark')} ${ahead === 1 ? 'sits' : 'sit'} above the line: our mark grew faster than the company EBITDA.`}
            {leftOut > 0
              ? ` ${plural(leftOut, 'position')} ${leftOut === 1 ? 'has' : 'have'} no EBITDA growth or no mark growth and ${leftOut === 1 ? 'is' : 'are'} not plotted.`
              : ''}
          </p>
        </>
      )}
    </Card>
  );
}

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'investmentNumber', label: 'Inv #', numeric: false },
  { key: 'companyName', label: 'Company', numeric: false },
  { key: 'entryMultiple', label: 'Entry EV / EBITDA', numeric: true },
  { key: 'currentMultiple', label: 'Current EV / EBITDA', numeric: true },
  { key: 'entryLeverage', label: 'Entry net debt / EBITDA', numeric: true },
  { key: 'currentLeverage', label: 'Current net debt / EBITDA', numeric: true },
  { key: 'ebitdaGrowth', label: 'EBITDA growth', numeric: true },
  { key: 'valuationGrowth', label: 'Mark growth', numeric: true },
  { key: 'gain', label: 'Our gain', numeric: true },
  { key: 'gainEbitdaGrowth', label: 'Gain: EBITDA growth', numeric: true },
  { key: 'gainMultipleExpansion', label: 'Gain: multiple expansion', numeric: true },
  { key: 'gainDebtPaydown', label: 'Gain: debt paydown', numeric: true },
  { key: 'grossMoic', label: 'Gross MOIC', numeric: true },
  { key: 'grossIrr', label: 'Gross IRR', numeric: true },
];

function PositionRow({ p }: { p: ValueCreationPosition }): ReactNode {
  const g = p.gainByDriver;
  return (
    <tr>
      <td>
        <span className="pb-key">{p.investmentNumber}</span>
      </td>
      <td>
        <Link to="/portfolio/$id/performance" params={{ id: p.id }}>
          {p.companyName}
        </Link>
        {/* A realized position holds no NAV: its gain is what was distributed less what was invested. */}
        {p.isActive ? null : <span className="pb-analytics-realized">Realized</span>}
      </td>
      <NumCell>{formatMultiple(p.entry?.evToEbitda ?? null)}</NumCell>
      <NumCell>{formatMultiple(p.current?.evToEbitda ?? null)}</NumCell>
      <NumCell>{formatMultiple(p.entry?.netDebtToEbitda ?? null)}</NumCell>
      <NumCell>{formatMultiple(p.current?.netDebtToEbitda ?? null)}</NumCell>
      <NumCell>{formatPct(p.growth.ebitdaGrowth)}</NumCell>
      <NumCell>{formatPct(p.valuationGrowth)}</NumCell>
      <NumCell>{formatMoneyM(p.gain)}</NumCell>
      {g === null ? (
        // The three drivers share one cell: the placeholder, and beside it the reason in words.
        <td colSpan={3} className="is-missing pb-analytics-reason">
          {MISSING}
          {p.gainNotCalculable === null ? null : ` ${REASON_TEXT[p.gainNotCalculable]}`}
        </td>
      ) : (
        <>
          <NumCell>{formatSignedMoneyM(g.ebitdaGrowth)}</NumCell>
          <NumCell>{formatSignedMoneyM(g.multipleExpansion)}</NumCell>
          <NumCell>{formatSignedMoneyM(g.debtPaydown)}</NumCell>
        </>
      )}
      <NumCell>{formatMoic(p.grossMoic)}</NumCell>
      <NumCell>{irrDisplay(p)}</NumCell>
    </tr>
  );
}

function PositionsCard({ view }: { view: ValueCreation }): ReactNode {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const log = useActionLog();
  const exporter = useMutation({ mutationFn: fetchValueCreationExport });
  const rows = sortPositions(view.positions, sort);
  const exportCsv = (): void => {
    const fileName = exportFileName(view.asOf);
    exporter.mutate(undefined, {
      onSuccess: (csv) => {
        downloadText(fileName, csv, 'text/csv');
        log.record('good', exportResult(csvRowCount(csv), fileName));
      },
      onError: (error) => log.record('bad', `Export CSV: ${describeActionError(error)}`),
    });
  };
  return (
    <Card testId="value-creation-positions">
      <SectionHeader aside={`${positionsText(view.positions.length)}; a company opens its deal`}>
        Positions
      </SectionHeader>
      <Toolbar
        end={
          <Button
            size="small"
            appearance="outline"
            icon={<ArrowDownload16Regular />}
            data-testid="value-creation-export"
            disabled={exporter.isPending}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
        }
      >
        <ActionStatus latest={log.latest} testId="value-creation-action-status" />
      </Toolbar>
      <TableWrap label="Value creation by position">
        <table className="pb-table pb-analytics-dense" aria-label="Value creation by position">
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const key = c.key;
                const active = sort.key === key;
                return (
                  <th
                    key={c.label}
                    scope="col"
                    className={c.numeric ? 'num' : undefined}
                    aria-sort={active ? sort.direction : 'none'}
                  >
                    <button
                      type="button"
                      className="pb-sort"
                      onClick={() => setSort((current) => nextSort(current, key))}
                    >
                      {c.label}
                      {active ? (
                        <span className="pb-sort-mark" aria-hidden="true">
                          {sort.direction === 'ascending' ? '▲' : '▼'}
                        </span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <PositionRow key={p.id} p={p} />
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

/**
 * Analytics, Value creation (docs/04 M13 and M20, docs/08 section 8): our gain and how it splits
 * into EBITDA growth, multiple expansion and debt paydown; valuation growth against EBITDA growth
 * per company; and the positions with their entry and current multiples, the three drivers, MOIC
 * and IRR. Every figure is the API's; the page formats, sorts and draws.
 */
export function ValueCreationTab(): ReactNode {
  const q = useQuery({ ...valueCreationQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (q.isError) return <UnavailableState card error={q.error} subject="Value creation" />;
  const view = q.data;
  const left = leftOutText(view.leftOut);
  if (view.positions.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No equity or continuation vehicle positions"
          detail={`Value creation is measured for equity co-investments and continuation vehicles you are entitled to see, as of ${formatDate(view.asOf)}.${left === null ? '' : ` ${left}`}`}
        />
      </Card>
    );
  }
  return (
    <>
      <HeadlineTiles portfolio={view.portfolio} />
      <p className="pb-meta">
        As of {formatDate(view.asOf)}, over the equity and continuation vehicle positions you are
        entitled to see, active and realized.{left === null ? '' : ` ${left}`}
      </p>
      <BridgeCard view={view} />
      <GrowthCard view={view} />
      <PositionsCard view={view} />
    </>
  );
}
