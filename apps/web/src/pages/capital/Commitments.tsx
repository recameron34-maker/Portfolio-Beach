import { useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { CommitmentList, FundCommitmentRow } from '@pb/contracts';
import { CAPITAL_TABS } from '../../app/nav.js';
import { commitmentsQuery } from '../../app/queries.js';
import { HorizontalBars } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyLine,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, labelOf, MISSING, plural } from '../../lib/format.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { distinctNames, isOverCalled, unfundedCaveats, unfundedChart } from './notices.js';
import './capital.css';
import { balanceTiles } from '../../lib/tiles.js';

/** Unfunded, with the over-called word on the figure's line when called beyond the commitment. */
function UnfundedCell({ row }: { row: FundCommitmentRow }): ReactNode {
  if (!isOverCalled(row)) return <NumCell>{formatMoneyM(row.unfunded)}</NumCell>;
  return (
    <td className="num">
      <span className="pb-cap-overcalled" title="Called beyond the commitment amount">
        <Badge tone="watch">Over-called</Badge>
      </span>
      {formatMoneyM(row.unfunded)}
    </td>
  );
}

/**
 * What identifies a sponsor fund under its name: the sponsor, the vintage and the strategy. A
 * vintage or strategy the record lacks shows the missing placeholder (docs/06), named for a screen
 * reader and in its title, since the line has no column header to name it.
 */
function fundDetail(row: FundCommitmentRow): ReactNode[] {
  const missing = (what: string): ReactNode => (
    <span title={`${what} not recorded`}>
      <span aria-hidden="true">{MISSING}</span>
      <span className="pb-visually-hidden">{what} not recorded</span>
    </span>
  );
  return [
    row.sponsorName,
    row.vintage === null ? missing('Vintage') : String(row.vintage),
    row.strategy === null ? missing('Strategy') : labelOf(row.strategy),
  ];
}

function UnfundedCard({ list }: { list: CommitmentList }): ReactNode {
  const chart = unfundedChart(list.items);
  const caveats = unfundedCaveats(chart);
  const largest = chart.bars[0];
  return (
    <Card testId="unfunded-card">
      <SectionHeader aside={`By sponsor fund, as of ${formatDate(list.asOf)}`}>
        Unfunded
      </SectionHeader>
      {largest === undefined ? (
        <EmptyLine
          title="No unfunded figures yet"
          detail="Unfunded is known once a commitment has a recorded cash flow; none has one yet."
        />
      ) : (
        <>
          <HorizontalBars
            title="Unfunded by sponsor fund"
            subtitle="Commitments with recorded cash flows"
            data={chart.bars}
            kind="money"
            valueColumn="Unfunded"
            summary={[
              `Unfunded by sponsor fund across ${plural(chart.bars.length, 'commitment')}; the largest is ${largest.label} at ${largest.display}.`,
              ...caveats,
            ].join(' ')}
            testId="unfunded-chart"
          />
          {caveats.length > 0 ? (
            <p className="pb-meta" data-testid="unfunded-caveats">
              {caveats.join(' ')}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * One row a commitment, folded to its figures: the sponsor fund with what identifies it under its
 * name, the vehicle with the client a separate account is for, then the figures and the date it
 * was committed. The total row is the API's.
 */
function CommitmentsTable({
  rows,
  list,
  showTotal,
}: {
  rows: readonly FundCommitmentRow[];
  list: CommitmentList;
  showTotal: boolean;
}): ReactNode {
  const t = list.totals;
  return (
    <TableWrap label="Commitments">
      <table className="pb-table pb-cap-commitments" aria-label="Commitments">
        <thead>
          <tr>
            <th>Sponsor fund</th>
            <th>Vehicle</th>
            <th className="num">Committed</th>
            <th className="num">Called</th>
            <th className="num">Distributed</th>
            <th className="num">Recallable</th>
            <th className="num">Unfunded</th>
            <th>Committed on</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="pb-cap-fund">
                {r.sponsorFundName}
                <span className="pb-cell-sub pb-cap-fund-detail">
                  {fundDetail(r).map((part, i) => (
                    <span key={i}>{part}</span>
                  ))}
                </span>
              </td>
              <td className="pb-cap-vehicle">
                {/* The API names a client only for a separate account the reader may see; a
                    pooled vehicle has no one client, so no line stands in for one. */}
                {r.vehicleName}
                {r.clientName === null ? null : <span className="pb-cell-sub">{r.clientName}</span>}
              </td>
              <NumCell>{formatMoneyM(r.amount)}</NumCell>
              <NumCell>{formatMoneyM(r.called)}</NumCell>
              <NumCell>{formatMoneyM(r.distributed)}</NumCell>
              <NumCell>{formatMoneyM(r.recallable)}</NumCell>
              <UnfundedCell row={r} />
              <td className="pb-nowrap">{formatDate(r.commitmentDate)}</td>
            </tr>
          ))}
        </tbody>
        {showTotal ? (
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td />
              <NumCell>{formatMoneyM(t.amount)}</NumCell>
              <NumCell>{formatMoneyM(t.called)}</NumCell>
              <NumCell>{formatMoneyM(t.distributed)}</NumCell>
              <td />
              <NumCell>{formatMoneyM(t.unfunded)}</NumCell>
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </TableWrap>
  );
}

/**
 * Commitments and unfunded (docs/04 M17): what each vehicle committed to each sponsor fund, what
 * the approved cash flows say was called, distributed and recalled, and what stays unfunded.
 * Totals come from the API (docs/08); the page never sums money.
 */
export function CommitmentsPage(): ReactNode {
  const [vehicle, setVehicle] = useState('');
  const q = useQuery({
    ...commitmentsQuery,
    placeholderData: keepPreviousData,
    retry: retryUnlessUnavailable,
  });
  if (q.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (q.isError) {
    return (
      <>
        <PageHeader title="Commitments and unfunded" />
        <TabNav label="Capital activity" items={CAPITAL_TABS} />
        <UnavailableState
          card
          error={q.error}
          subject="Commitments"
          errorTitle="Commitments unavailable"
          testId="commitments-unavailable"
        />
      </>
    );
  }
  const list = q.data;
  const t = list.totals;
  const vehicles = distinctNames(list.items.map((r) => r.vehicleName));
  const rows = vehicle === '' ? list.items : list.items.filter((r) => r.vehicleName === vehicle);
  return (
    <>
      <PageHeader title="Commitments and unfunded" meta={`As of ${formatDate(list.asOf)}`} />
      <TabNav label="Capital activity" items={CAPITAL_TABS} />
      <div ref={balanceTiles} className="pb-tiles" data-testid="commitment-tiles">
        <StatTile
          label="Committed"
          value={formatMoneyM(t.amount)}
          hint={plural(list.items.length, 'commitment')}
        />
        <StatTile label="Called" value={formatMoneyM(t.called)} hint="Contributions to date" />
        <StatTile
          label="Distributed"
          value={formatMoneyM(t.distributed)}
          hint="Distributions to date"
        />
        <StatTile
          label="Unfunded"
          value={formatMoneyM(t.unfunded)}
          hint="Committed less called, plus recallable"
        />
      </div>
      <UnfundedCard list={list} />
      <Card testId="commitments-card">
        <SectionHeader
          aside={
            vehicle === ''
              ? plural(rows.length, 'commitment')
              : `${rows.length} of ${plural(list.items.length, 'commitment')}`
          }
        >
          Commitments
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="commitment-vehicle">Vehicle</Label>
            <Dropdown
              id="commitment-vehicle"
              className="pb-cap-filter is-wide"
              value={vehicle === '' ? 'All vehicles' : vehicle}
              selectedOptions={[vehicle]}
              onOptionSelect={(_e, d) => setVehicle(d.optionValue ?? '')}
            >
              <Option value="">All vehicles</Option>
              {vehicles.map((v) => (
                <Option key={v} value={v}>
                  {v}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {rows.length === 0 ? (
          <EmptyState
            title="No commitments"
            detail="No commitment you are entitled to see is recorded for this selection."
          />
        ) : (
          <CommitmentsTable rows={rows} list={list} showTotal={vehicle === ''} />
        )}
        {vehicle === '' ? null : (
          <p className="pb-meta">
            The total covers every vehicle, so it shows only with All vehicles selected.
          </p>
        )}
        <p className="pb-meta" data-testid="commitments-note">
          Totals add the commitments whose figures are known; one with no recorded cash flow shows{' '}
          {MISSING}. Figures use calculation rules version {list.calcVersion}.
        </p>
      </Card>
    </>
  );
}
