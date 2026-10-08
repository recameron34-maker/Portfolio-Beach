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
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, labelOf, MISSING } from '../../lib/format.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { distinctNames, isOverCalled, unfundedCaveats, unfundedChart } from './notices.js';
import './capital.css';

function UnfundedCell({ row }: { row: FundCommitmentRow }): ReactNode {
  if (!isOverCalled(row)) return <NumCell>{formatMoneyM(row.unfunded)}</NumCell>;
  return (
    <td className="num">
      <span className="pb-cap-overcalled">
        <span title="Called beyond the commitment amount">
          <Badge tone="watch">Over-called</Badge>
        </span>
        {formatMoneyM(row.unfunded)}
      </span>
    </td>
  );
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
        <EmptyState
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
              `Unfunded by sponsor fund across ${chart.bars.length} commitments; the largest is ${largest.label} at ${largest.display}.`,
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

function CommitmentsTable({
  rows,
  list,
  showTotal,
}: {
  rows: readonly FundCommitmentRow[];
  list: CommitmentList;
  showTotal: boolean;
}): ReactNode {
  const hasClient = rows.some((r) => r.clientName !== null);
  const t = list.totals;
  return (
    <div className="pb-table-wrap">
      <table className="pb-table pb-cap-commitments" aria-label="Commitments">
        <thead>
          <tr>
            <th>Sponsor fund</th>
            <th>Sponsor</th>
            <th>Vehicle</th>
            <th className="num">Vintage</th>
            <th>Strategy</th>
            {hasClient ? <th>Client</th> : null}
            <th className="num">Committed</th>
            <th className="num">Called</th>
            <th className="num">Distributed</th>
            <th className="num">Recallable</th>
            <th className="num">Unfunded</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.sponsorFundName}</td>
              <td>{r.sponsorName}</td>
              <td>{r.vehicleName}</td>
              <NumCell>{r.vintage === null ? MISSING : String(r.vintage)}</NumCell>
              <td>{labelOf(r.strategy)}</td>
              {hasClient ? (
                <td className={r.clientName === null ? 'is-missing' : undefined}>
                  {r.clientName ?? MISSING}
                </td>
              ) : null}
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
              <th scope="row" colSpan={hasClient ? 6 : 5}>
                Total
              </th>
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
    </div>
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
      <div className="pb-tiles" data-testid="commitment-tiles">
        <StatTile
          label="Committed"
          value={formatMoneyM(t.amount)}
          hint={`${list.items.length} commitments`}
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
              ? `${rows.length} commitments`
              : `${rows.length} of ${list.items.length} commitments`
          }
        >
          Commitments
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="commitment-vehicle">Vehicle</Label>
            <Dropdown
              id="commitment-vehicle"
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
            The total row covers every vehicle and comes from the API, so it shows only with All
            vehicles selected.
          </p>
        )}
        <p className="pb-meta" data-testid="commitments-note">
          Totals sum the commitments whose figures are known; a commitment with no recorded cash
          flow shows the missing placeholder. Calc version {list.calcVersion} (docs/08).
        </p>
      </Card>
    </>
  );
}
