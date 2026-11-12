import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option, Switch } from '@fluentui/react-components';
import { ArrowDownload16Regular } from '@fluentui/react-icons';
import type { ValueCreation, ValueCreationFilters, ValueCreationPosition } from '@pb/contracts';
import { describeActionError } from '../../app/mutations.js';
import { BridgeChart, ScatterChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  Field,
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
import { hasFilters } from './value-creation-filters.js';
import { shownView } from './value-creation-view.js';
import type { ShownView } from './value-creation-view.js';
import { useValueCreationFilters } from './useValueCreationFilters.js';
import { ValueCreationFilterBar } from './ValueCreationFilterBar.js';
import {
  canOpenEbitda,
  DEFAULT_SORT,
  exportFileName,
  formatSignedMoneyM,
  GROWTH_MEASURES,
  growthMeasure,
  growthPoints,
  leftOutText,
  MARK_AND_TIMING,
  nextSort,
  portfolioBridgeSteps,
  positionsText,
  REASON_TEXT,
  sortPositions,
} from './value-creation.js';
import type { GrowthMeasure, SortKey, SortState } from './value-creation.js';
import './analytics.css';

type Portfolio = ValueCreation['portfolio'];

/** The headline: our gain over the positions it is split for, the three drivers and mark and timing. */
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
        hint="Earnings growth at the entry multiple, at our stake"
      />
      <StatTile
        label="Multiple expansion"
        value={formatSignedMoneyM(g?.multipleExpansion ?? null)}
        hint="Change in EV / EBITDA on current earnings, at our stake"
      />
      <StatTile
        label="Debt paydown"
        value={formatSignedMoneyM(g?.debtPaydown ?? null)}
        hint="Fall in net debt since entry, at our stake"
      />
      <StatTile
        label={MARK_AND_TIMING}
        value={formatSignedMoneyM(g?.other ?? null)}
        hint="The rest of our gain"
      />
    </div>
  );
}

/** The positions the split leaves out: a quiet count, the positions and their reasons on demand. */
function NotCalculableNote({
  positions,
}: {
  positions: readonly ValueCreationPosition[];
}): ReactNode {
  const left = positions.filter((p) => p.gainNotCalculable !== null);
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

function BridgeCard({ view }: { view: ShownView }): ReactNode {
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
          detail="The split needs an approved entry snapshot with a positive equity value, an approved quarter with positive EBITDA and a Locked valuation. The reasons are listed below, position by position."
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
            summary={`Our gain of ${formatMoneyM(portfolio.gain)} over ${positionsText(portfolio.positions)}: EBITDA growth ${formatSignedMoneyM(g.ebitdaGrowth)}, multiple expansion ${formatSignedMoneyM(g.multipleExpansion)}, debt paydown ${formatSignedMoneyM(g.debtPaydown)} and mark and timing ${formatSignedMoneyM(g.other)}, from ${formatMoneyM(portfolio.invested)} invested to ${formatMoneyM(portfolio.totalValue)} of value now.`}
            testId="value-creation-bridge"
          />
          <p className="pb-meta pb-analytics-note" data-testid="value-creation-bridge-note">
            Each position&apos;s gain is set against its company&apos;s bridge at our entry stake
            (our invested capital over the company&apos;s equity value at entry): EBITDA growth at
            the entry multiple, then the change in the multiple, then the fall in net debt. Mark and
            timing is the rest of our gain: our mark against the company&apos;s value, fees, the
            timing of cash flows, follow-on investments and realizations.
          </p>
        </>
      )}
      <NotCalculableNote positions={view.positions} />
    </Card>
  );
}

function GrowthCard({ positions }: { positions: readonly ValueCreationPosition[] }): ReactNode {
  const [measure, setMeasure] = useState<GrowthMeasure>('mark');
  const id = useId();
  const words = growthMeasure(measure);
  const { points, leftOut, seriesNames, ahead } = growthPoints(positions, measure);
  return (
    <Card testId="value-creation-growth-card">
      <SectionHeader aside="Since entry, one mark per company">
        Valuation and earnings
      </SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor={id}>Valuation measure</Label>
          <Dropdown
            id={id}
            className="pb-analytics-filter"
            data-testid="value-creation-measure"
            value={words.label}
            selectedOptions={[measure]}
            onOptionSelect={(_e, d) =>
              setMeasure(GROWTH_MEASURES.find((m) => m.key === d.optionValue)?.key ?? 'mark')
            }
          >
            {GROWTH_MEASURES.map((m) => (
              <Option key={m.key} value={m.key}>
                {m.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <span className="pb-meta" data-testid="value-creation-measure-note">
          Levered equity usually grows faster than EBITDA; enterprise value is the like-for-like
          view.
        </span>
      </Toolbar>
      {points.length === 0 ? (
        <EmptyState
          title="No position has both figures"
          detail={`The chart needs EBITDA growth since entry and ${words.missing} for a position.`}
        />
      ) : (
        <>
          <ScatterChart
            title="Valuation growth against EBITDA growth"
            subtitle="The dashed line is where the two are equal"
            points={points}
            xLabel="EBITDA growth since entry"
            yLabel={words.axis}
            xKind="pct"
            yKind="pct"
            seriesNames={seriesNames}
            seriesLabel="Side of the line"
            equalLine
            summary={`${words.summary} against the company's EBITDA growth since entry for ${plural(points.length, 'position')}; ${ahead} sit above the line where the two are equal.`}
            testId="value-creation-scatter"
          />
          <p className="pb-meta pb-analytics-note">
            {`${ahead} of ${plural(points.length, 'mark')} ${ahead === 1 ? 'sits' : 'sit'} above the line: ${words.subject} grew faster than the company EBITDA.`}
            {leftOut > 0
              ? ` ${plural(leftOut, 'position')} ${leftOut === 1 ? 'has' : 'have'} no EBITDA growth or no ${words.missing} and ${leftOut === 1 ? 'is' : 'are'} not plotted.`
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
  { key: 'stake', label: 'Entry stake', numeric: true },
  { key: 'gain', label: 'Our gain', numeric: true },
  { key: 'gainEbitdaGrowth', label: 'Gain: EBITDA growth', numeric: true },
  { key: 'gainMultipleExpansion', label: 'Gain: multiple expansion', numeric: true },
  { key: 'gainDebtPaydown', label: 'Gain: debt paydown', numeric: true },
  { key: 'gainOther', label: 'Gain: mark and timing', numeric: true },
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
      <NumCell>{formatPct(p.stake)}</NumCell>
      <NumCell>{formatMoneyM(p.gain)}</NumCell>
      {g === null ? (
        // The four parts share one cell: the placeholder, and beside it the reason in words.
        <td colSpan={4} className="is-missing pb-analytics-reason">
          {MISSING}
          {p.gainNotCalculable === null ? null : ` ${REASON_TEXT[p.gainNotCalculable]}`}
        </td>
      ) : (
        <>
          <NumCell>{formatSignedMoneyM(g.ebitdaGrowth)}</NumCell>
          <NumCell>{formatSignedMoneyM(g.multipleExpansion)}</NumCell>
          <NumCell>{formatSignedMoneyM(g.debtPaydown)}</NumCell>
          <NumCell>{formatSignedMoneyM(g.other)}</NumCell>
        </>
      )}
      <NumCell>{formatMoic(p.grossMoic)}</NumCell>
      <NumCell>{irrDisplay(p)}</NumCell>
    </tr>
  );
}

function PositionsCard({
  view,
  filters,
}: {
  view: ShownView;
  filters: ValueCreationFilters;
}): ReactNode {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const log = useActionLog();
  const exporter = useMutation({ mutationFn: fetchValueCreationExport });
  const rows = sortPositions(view.positions, sort);
  const exportCsv = (): void => {
    const fileName = exportFileName(view.asOf);
    // The export is the API's (audited, SEC-11.1), asked with the filters of this view, which it
    // applies by the rule the page filtered its rows with.
    exporter.mutate(filters, {
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
 * into EBITDA growth, multiple expansion, debt paydown and mark and timing; valuation growth
 * against EBITDA growth per company, on our mark, the company equity value or the enterprise
 * value; and the positions with their entry and current multiples, our entry stake, the parts of
 * the gain, MOIC and IRR. The filters narrow the positions, and every figure is the roll-up of the
 * rows that pass (value-creation-view.ts), the rule the API rolls the whole book up by.
 */
export function ValueCreationTab(): ReactNode {
  const q = useQuery({ ...valueCreationQuery, placeholderData: keepPreviousData });
  const [filters, setFilters] = useValueCreationFilters();
  const view = q.data;
  const shown = useMemo(
    () => (view === undefined ? null : shownView(view, filters)),
    [view, filters],
  );
  if (q.isPending) return <PageSkeleton tiles={5} rows={6} />;
  if (q.isError) return <UnavailableState card error={q.error} subject="Value creation" />;
  if (view === undefined || shown === null) return null;
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
  const bar = (
    <ValueCreationFilterBar
      positions={view.positions}
      shown={shown.positions.length}
      filters={filters}
      onChange={setFilters}
    />
  );
  if (shown.positions.length === 0) {
    return (
      <>
        {bar}
        <Card testId="value-creation-no-match">
          <EmptyState
            title="No position matches these filters"
            detail="Pick another vehicle, sponsor, sector, deal type, entry year or status, or clear the filters."
          />
        </Card>
      </>
    );
  }
  return (
    <>
      <HeadlineTiles portfolio={shown.portfolio} />
      {bar}
      <p className="pb-meta">
        As of {formatDate(view.asOf)}, over the equity and continuation vehicle positions you are
        entitled to see, active and realized
        {hasFilters(filters) ? ', narrowed by the filters above' : ''}.
        {left === null ? '' : ` ${left}`}
      </p>
      <BridgeCard view={shown} />
      <GrowthCard positions={shown.positions} />
      <PositionsCard view={shown} filters={filters} />
    </>
  );
}
