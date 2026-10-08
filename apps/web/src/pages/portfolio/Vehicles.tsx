import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft16Regular } from '@fluentui/react-icons';
import type {
  InvestmentSummary,
  PooledMetrics,
  VehicleDetail,
  VehicleSummary,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { PORTFOLIO_TABS } from '../../app/nav.js';
import { vehicleQuery, vehiclesQuery } from '../../app/queries.js';
import { HorizontalBars, LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TabNav,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatPct,
  irrDisplay,
  labelOf,
  MISSING,
  moneyLabel,
} from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import {
  activePositionBars,
  CLIENT_DATA_VISIBILITY,
  closingsLabel,
  finalCloseLabel,
  NO_CASH_FLOW_NOTE,
  quarterLabel,
} from './vehicle-ui.js';
import './vehicles.css';

/* ---- Vehicles list (/portfolio/vehicles) ---- */

function VehiclesTable({ items }: { items: VehicleSummary[] }): ReactNode {
  return (
    <div className="pb-table-wrap">
      <table className="pb-table" aria-label="Vehicles">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th className="num">Vintage</th>
            <th className="num">Active positions</th>
            <th className="num">LP commitments</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td className="pb-nowrap">
                <Link to="/portfolio/vehicles/$id" params={{ id: v.id }}>
                  {v.name}
                </Link>
              </td>
              <td className="pb-nowrap">{labelOf(v.vehicleType)}</td>
              <NumCell>{v.vintage === null ? MISSING : String(v.vintage)}</NumCell>
              <NumCell>{String(v.activeInvestments)}</NumCell>
              <NumCell>{formatMoneyM(v.lpCommitmentsTotal)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivePositionsCard({ items }: { items: VehicleSummary[] }): ReactNode {
  const bars = activePositionBars(items);
  const top = bars[0];
  const total = bars.reduce((sum, b) => sum + b.value, 0);
  return (
    <Card>
      <SectionHeader aside="Realized positions are not counted">Active positions</SectionHeader>
      {top === undefined || top.value === 0 ? (
        <EmptyState
          title="No active positions"
          detail="No vehicle you can see holds an active position."
        />
      ) : (
        <HorizontalBars
          title="Active positions by vehicle"
          data={bars}
          kind="count"
          valueColumn="Active positions"
          summary={`${total} active positions across ${bars.length} vehicles; the most any one vehicle holds is ${top.display}.`}
          testId="vehicles-active-positions"
        />
      )}
    </Card>
  );
}

function VehiclesBody({ items }: { items: VehicleSummary[] }): ReactNode {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No vehicles visible"
          detail="Vehicles appear here once operations sets them up."
          testId="vehicles-empty"
        />
      </Card>
    );
  }
  const noClientData = items.every((v) => v.lpCommitmentsTotal === null);
  return (
    <>
      <Card>
        <SectionHeader aside={items.length === 1 ? '1 vehicle' : `${items.length} vehicles`}>
          Funds and vehicles
        </SectionHeader>
        <VehiclesTable items={items} />
        <p className="pb-meta pb-vehicles-note" data-testid="vehicles-client-note">
          {noClientData
            ? `${CLIENT_DATA_VISIBILITY}.`
            : 'LP commitments total the client commitments you are entitled to see.'}
        </p>
      </Card>
      <ActivePositionsCard items={items} />
    </>
  );
}

/** Every firm vehicle with its type, vintage, active positions and, for entitled roles, LP commitments (M17). */
export function VehiclesPage(): ReactNode {
  const q = useQuery({ ...vehiclesQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton rows={6} />;
  return (
    <>
      <PageHeader
        title="Vehicles"
        meta="The firm's funds and vehicles. Open one for its schedule of investments, commitments and closings."
      />
      <TabNav label="Portfolio" items={PORTFOLIO_TABS} />
      {q.isError ? (
        <UnavailableState card error={q.error} subject="Vehicles" testId="vehicles-unavailable" />
      ) : (
        <VehiclesBody items={q.data.items} />
      )}
    </>
  );
}

/* ---- Vehicle detail (/portfolio/vehicles/$id) ---- */

function BackToVehicles(): ReactNode {
  return (
    <p className="pb-vehicles-back">
      <Link to="/portfolio/vehicles">
        <ChevronLeft16Regular />
        All vehicles
      </Link>
    </p>
  );
}

function StatusBadge({ active }: { active: boolean }): ReactNode {
  return active ? <Badge tone="brand">Active</Badge> : <Badge tone="neutral">Realized</Badge>;
}

function VehicleTiles({ vehicle }: { vehicle: VehicleDetail }): ReactNode {
  const m = vehicle.metrics;
  return (
    <div className="pb-tiles pb-vehicles-tiles" data-testid="vehicle-tiles">
      <StatTile
        label="Positions"
        value={String(m.count)}
        hint={`${vehicle.activeInvestments} active`}
      />
      <StatTile label="Invested" value={formatMoneyM(m.invested)} hint="Contributions to date" />
      <StatTile label="Distributions" value={formatMoneyM(m.distributions)} />
      <StatTile label="NAV" value={formatMoneyM(m.nav)} hint="Locked marks only" />
      <StatTile label="DPI" value={formatMoic(m.dpi)} hint="Distributions / invested" />
      <StatTile label="TVPI" value={formatMoic(m.tvpi)} hint="(Distributions + NAV) / invested" />
      <StatTile label="Gross MOIC" value={formatMoic(m.grossMoic)} hint="Before fees and carry" />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(m)}
        hint={irrFlagHint(m.irrFlag) ?? 'Pooled cash flows, XIRR'}
      />
    </div>
  );
}

function NavTrendCard({ vehicle }: { vehicle: VehicleDetail }): ReactNode {
  const points = vehicle.navSeries;
  const known = points.filter((p) => p.value !== null);
  const first = known[0];
  const last = known[known.length - 1];
  return (
    <Card>
      <SectionHeader aside="Sum of the positions' Locked fair values">NAV trend</SectionHeader>
      {known.length < 2 || first === undefined || last === undefined ? (
        <EmptyState
          title="No NAV trend yet"
          detail="The series sums Locked fair values by quarter end and needs at least two quarters with Locked marks."
          testId="vehicle-nav-empty"
        />
      ) : (
        <LineChart
          title="NAV by quarter"
          subtitle={`Locked marks only, last ${points.length} quarters`}
          x={points.map((p) => quarterLabel(p.periodEnd))}
          series={[
            { name: 'NAV', values: points.map((p) => (p.value === null ? null : Number(p.value))) },
          ]}
          kind="money"
          format={moneyLabel}
          summary={`NAV by quarter over ${points.length} quarters, from ${formatMoneyM(first.value)} in ${quarterLabel(first.periodEnd)} to ${formatMoneyM(last.value)} in ${quarterLabel(last.periodEnd)}.`}
          testId="vehicle-nav-series"
        />
      )}
    </Card>
  );
}

function ScheduleTable({
  positions,
  metrics,
}: {
  positions: InvestmentSummary[];
  metrics: PooledMetrics;
}): ReactNode {
  return (
    <div className="pb-table-wrap">
      <table className="pb-table pb-vehicles-table" aria-label="Schedule of investments">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company and sponsor</th>
            <th>Deal type</th>
            <th>Entry</th>
            <th className="num">Invested</th>
            <th className="num">Distributed</th>
            <th className="num">NAV</th>
            <th className="num">Gross MOIC</th>
            <th className="num">Gross IRR</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="pb-key">{p.investmentNumber}</span>
              </td>
              <td>
                <Link to="/portfolio/$id" params={{ id: p.id }}>
                  {p.companyName}
                </Link>
                <span className="pb-vehicles-sub">{p.sponsorName}</span>
              </td>
              <td>{labelOf(p.dealType)}</td>
              <td className="pb-nowrap">{formatDate(p.entryDate)}</td>
              <NumCell>{formatMoneyM(p.invested)}</NumCell>
              <NumCell>{formatMoneyM(p.distributions)}</NumCell>
              <NumCell>{formatMoneyM(p.nav)}</NumCell>
              <NumCell>{formatMoic(p.grossMoic)}</NumCell>
              <NumCell>{irrDisplay(p)}</NumCell>
              <td>
                <StatusBadge active={p.isActive} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={4}>
              Total
            </th>
            <NumCell>{formatMoneyM(metrics.invested)}</NumCell>
            <NumCell>{formatMoneyM(metrics.distributions)}</NumCell>
            <NumCell>{formatMoneyM(metrics.nav)}</NumCell>
            <NumCell>{formatMoic(metrics.grossMoic)}</NumCell>
            <NumCell>{irrDisplay(metrics)}</NumCell>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ScheduleCard({ vehicle }: { vehicle: VehicleDetail }): ReactNode {
  const count = vehicle.positions.length;
  return (
    <Card>
      <SectionHeader
        aside={
          count === 0
            ? undefined
            : `${count} ${count === 1 ? 'position' : 'positions'}, ${vehicle.activeInvestments} active`
        }
      >
        Schedule of investments
      </SectionHeader>
      {count === 0 ? (
        <EmptyState
          title="No positions in this vehicle"
          detail={
            vehicle.fundCommitments.length > 0
              ? 'This vehicle holds commitments to sponsor funds rather than positions, so there are no pooled figures or NAV trend; the commitments are listed below.'
              : 'Positions, pooled figures and the NAV trend appear here once the vehicle invests.'
          }
          testId="vehicle-positions-empty"
        />
      ) : (
        <ScheduleTable positions={vehicle.positions} metrics={vehicle.metrics} />
      )}
    </Card>
  );
}

function FundCommitmentsCard({ vehicle }: { vehicle: VehicleDetail }): ReactNode {
  const rows = vehicle.fundCommitments;
  return (
    <Card>
      <SectionHeader
        aside={
          rows.length === 0
            ? undefined
            : `${rows.length} ${rows.length === 1 ? 'commitment' : 'commitments'} to sponsor funds`
        }
      >
        Fund commitments
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No fund commitments"
          detail="Commitments this vehicle makes to sponsor funds appear here."
          testId="vehicle-fund-commitments-empty"
        />
      ) : (
        <>
          <div className="pb-table-wrap">
            <table className="pb-table" aria-label="Fund commitments">
              <thead>
                <tr>
                  <th>Sponsor fund and sponsor</th>
                  <th className="num">Vintage</th>
                  <th>Strategy</th>
                  <th className="num">Committed</th>
                  <th className="num">Called</th>
                  <th className="num">Distributed</th>
                  <th className="num">Recallable</th>
                  <th className="num">Unfunded</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.sponsorFundName}
                      <span className="pb-vehicles-sub">
                        <Link to="/sponsors/$id" params={{ id: c.sponsorId }}>
                          {c.sponsorName}
                        </Link>
                      </span>
                    </td>
                    <NumCell>{c.vintage === null ? MISSING : String(c.vintage)}</NumCell>
                    <td>{labelOf(c.strategy)}</td>
                    <NumCell>{formatMoneyM(c.amount)}</NumCell>
                    <NumCell>{formatMoneyM(c.called)}</NumCell>
                    <NumCell>{formatMoneyM(c.distributed)}</NumCell>
                    <NumCell>{formatMoneyM(c.recallable)}</NumCell>
                    <NumCell>{formatMoneyM(c.unfunded)}</NumCell>
                    <td className="pb-nowrap">{formatDate(c.commitmentDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pb-meta pb-vehicles-note">{NO_CASH_FLOW_NOTE}</p>
        </>
      )}
    </Card>
  );
}

function ClientCommitmentsCard({ vehicle }: { vehicle: VehicleDetail }): ReactNode {
  const rows = vehicle.lpCommitments;
  return (
    <Card testId="vehicle-client-commitments">
      <SectionHeader
        aside={
          rows === null || rows.length === 0
            ? undefined
            : 'Closing number and ownership after each close'
        }
      >
        Client commitments
      </SectionHeader>
      {rows === null ? (
        <EmptyState title={CLIENT_DATA_VISIBILITY} testId="client-commitments-hidden" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No client commitments"
          detail="No client you can see has committed to this vehicle."
          testId="client-commitments-empty"
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table pb-vehicles-table" aria-label="Client commitments">
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Closing</th>
                <th className="num">Committed</th>
                <th className="num">Ownership</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={`${c.clientId}-${c.closingNumber}`}>
                  <td className="pb-nowrap">{c.clientName}</td>
                  <NumCell>{String(c.closingNumber)}</NumCell>
                  <NumCell>{formatMoneyM(c.amount)}</NumCell>
                  <NumCell>{formatPct(c.ownershipPct)}</NumCell>
                  <td className="pb-nowrap">{formatDate(c.commitmentDate)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Total
                </th>
                <NumCell>{formatMoneyM(vehicle.lpCommitmentsTotal)}</NumCell>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function VehicleUnavailable({ error }: { error: Error }): ReactNode {
  const hidden = error instanceof ApiError && (error.status === 404 || error.status === 403);
  return (
    <>
      <BackToVehicles />
      {hidden ? (
        <ErrorState
          title="Vehicle not found or not visible to you"
          detail="Check the link, or open the vehicle from the list of vehicles."
        />
      ) : (
        <UnavailableState
          card
          error={error}
          subject="This vehicle"
          errorTitle="Could not load this vehicle"
        />
      )}
    </>
  );
}

/**
 * One vehicle (M17): pooled figures and the NAV trend when it holds positions, the schedule of
 * investments, its commitments to sponsor funds and, for entitled roles, the client commitments.
 */
export function VehicleDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/portfolio/vehicles/$id' });
  const q = useQuery(vehicleQuery(id));
  if (q.isPending) return <PageSkeleton tiles={8} rows={6} />;
  if (q.isError) return <VehicleUnavailable error={q.error} />;
  const v = q.data;
  // Nothing pools without a visible position: the empty schedule says why instead of eight blank tiles.
  const pooled = v.metrics.count > 0;
  return (
    <>
      <BackToVehicles />
      <PageHeader
        testId="vehicle-banner"
        title={v.name}
        meta={
          <span className="pb-meta-list">
            <span>{labelOf(v.vehicleType)}</span>
            <span>Vintage {v.vintage ?? MISSING}</span>
            <span>{v.currency}</span>
            <span>{closingsLabel(v.closingCount)}</span>
            <span>{finalCloseLabel(v.finalCloseDate)}</span>
            <span>As of {formatDate(v.asOf)}</span>
          </span>
        }
      />
      {pooled ? <VehicleTiles vehicle={v} /> : null}
      {pooled ? <NavTrendCard vehicle={v} /> : null}
      <ScheduleCard vehicle={v} />
      <FundCommitmentsCard vehicle={v} />
      <ClientCommitmentsCard vehicle={v} />
      <p className="pb-meta" data-testid="vehicle-calc-version">
        Calc version {v.calcVersion}.
      </p>
    </>
  );
}
