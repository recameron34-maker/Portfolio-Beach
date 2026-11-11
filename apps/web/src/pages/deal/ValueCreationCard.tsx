import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Switch } from '@fluentui/react-components';
import type {
  InvestmentValueCreation,
  ValueCreationBridge,
  ValueCreationPosition,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { BridgeChart, LineChart } from '../../components/charts/index.js';
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
import {
  formatDate,
  formatMoneyM,
  formatMonthYearShort,
  formatMultiple,
  formatPct,
} from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { investmentValueCreationQuery } from '../analytics/value-creation-queries.js';
import {
  canOpenEbitda,
  companyBridgeSteps,
  formatSignedMoneyM,
  formatSignedTurns,
  REASON_TEXT,
} from '../analytics/value-creation.js';
import { toNumber } from './data.js';
import './deal.css';

/** The headline of the card: the change in the company's equity value and the three drivers with their shares. */
function BridgeTiles({ bridge }: { bridge: ValueCreationBridge }): ReactNode {
  const share = (value: string | undefined): string =>
    value === undefined ? 'No share: the total is zero' : `${formatPct(value)} of the change`;
  return (
    <div
      ref={balanceTiles}
      className="pb-tiles pb-deal-tiles pb-deal-aligned"
      data-testid="deal-value-creation-tiles"
    >
      <StatTile
        label="Equity value change"
        value={formatSignedMoneyM(bridge.total)}
        hint={`${formatMoneyM(bridge.equityAtEntry)} at entry to ${formatMoneyM(bridge.equityCurrent)} now`}
      />
      <StatTile
        label="EBITDA growth"
        value={formatSignedMoneyM(bridge.ebitdaGrowth)}
        hint={share(bridge.shares?.ebitdaGrowth)}
      />
      <StatTile
        label="Multiple expansion"
        value={formatSignedMoneyM(bridge.multipleExpansion)}
        hint={share(bridge.shares?.multipleExpansion)}
      />
      <StatTile
        label="Debt paydown"
        value={formatSignedMoneyM(bridge.debtPaydown)}
        hint={share(bridge.shares?.debtPaydown)}
      />
    </div>
  );
}

/** Our own gain on the position and how the company's shares split it, in one sentence. */
function OursLine({ p }: { p: ValueCreationPosition }): ReactNode {
  const g = p.gainByDriver;
  const reason = p.gainNotCalculable === null ? null : REASON_TEXT[p.gainNotCalculable];
  return (
    <p className="pb-meta pb-deal-note" data-testid="deal-value-creation-ours">
      {g !== null
        ? `Our gain on this position is ${formatMoneyM(p.gain)}: ${formatSignedMoneyM(g.ebitdaGrowth)} from EBITDA growth, ${formatSignedMoneyM(g.multipleExpansion)} from multiple expansion and ${formatSignedMoneyM(g.debtPaydown)} from debt paydown, split by the company shares above.`
        : p.gain === null
          ? `Our gain on this position is not calculable${reason === null ? '.' : `: ${reason}.`}`
          : `Our gain on this position is ${formatMoneyM(p.gain)}. It is not split by driver${reason === null ? '.' : `: ${reason}.`}`}
    </p>
  );
}

function BridgeBlock({ p, company }: { p: ValueCreationPosition; company: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const bridge = p.bridge;
  if (bridge === null) {
    return (
      <EmptyState
        title="The value creation bridge is not calculable"
        detail={p.notCalculable === null ? undefined : `${REASON_TEXT[p.notCalculable]}.`}
        testId="deal-value-creation-not-calculable"
      />
    );
  }
  return (
    <>
      <BridgeTiles bridge={bridge} />
      <Toolbar>
        <Switch
          checked={open}
          disabled={!canOpenEbitda(bridge)}
          onChange={(_e, data) => setOpen(data.checked)}
          label="Open EBITDA growth into revenue growth and margin change"
        />
      </Toolbar>
      <BridgeChart
        title="Value creation bridge"
        subtitle="The company's equity value, entry to current quarter"
        steps={companyBridgeSteps(bridge, open)}
        kind="money"
        summary={`Equity value of ${company} from ${formatMoneyM(bridge.equityAtEntry)} at entry to ${formatMoneyM(bridge.equityCurrent)} now: EBITDA growth ${formatSignedMoneyM(bridge.ebitdaGrowth)}, multiple expansion ${formatSignedMoneyM(bridge.multipleExpansion)} and debt paydown ${formatSignedMoneyM(bridge.debtPaydown)}.`}
        testId="deal-value-creation-bridge"
      />
    </>
  );
}

const indexLabel = (value: number): string => value.toFixed(1);

/** The four lines by quarter: the company's EBITDA, EV and equity value at 100 on entry, our mark per 100 invested. */
function IndexedLines({
  data,
  company,
}: {
  data: InvestmentValueCreation;
  company: string;
}): ReactNode {
  const points = data.series;
  const last = points[points.length - 1];
  if (last === undefined || points.every((p) => p.isEntry)) {
    return (
      <EmptyState
        title="No approved quarter to chart"
        detail="The lines are drawn from approved quarters on or before the as-of date."
      />
    );
  }
  const shown = (value: string | null): string =>
    value === null ? 'not on record' : indexLabel(Number(value));
  return (
    <LineChart
      title="Indexed since entry"
      subtitle="Company figures at 100 on entry; our mark per 100 invested"
      x={points.map((p) => (p.isEntry ? 'Entry' : formatMonthYearShort(p.periodEnd)))}
      series={[
        { name: 'EBITDA', values: points.map((p) => toNumber(p.ebitdaIndex)) },
        { name: 'EV', values: points.map((p) => toNumber(p.evIndex)) },
        { name: 'Equity value', values: points.map((p) => toNumber(p.equityValueIndex)) },
        { name: 'Our mark', values: points.map((p) => toNumber(p.markIndex)) },
      ]}
      kind="count"
      format={indexLabel}
      summary={`Indexed lines for ${company} over ${points.length} points to ${formatDate(last.periodEnd)}: EBITDA ${shown(last.ebitdaIndex)}, EV ${shown(last.evIndex)}, equity value ${shown(last.equityValueIndex)} against 100 at entry, and our mark ${shown(last.markIndex)} per 100 invested.`}
      testId="deal-value-creation-index"
    />
  );
}

/** Entry against current: the figures of the two quarters and what changed between them. */
function EntryCurrentTable({ p }: { p: ValueCreationPosition }): ReactNode {
  const { entry, current, growth } = p;
  const rows: { label: string; entry: string; current: string; change: string }[] = [
    {
      label: 'EBITDA, LTM',
      entry: formatMoneyM(entry?.ebitdaLtm ?? null),
      current: formatMoneyM(current?.ebitdaLtm ?? null),
      change: formatPct(growth.ebitdaGrowth),
    },
    {
      label: 'Enterprise value',
      entry: formatMoneyM(entry?.ev ?? null),
      current: formatMoneyM(current?.ev ?? null),
      change: formatPct(growth.evGrowth),
    },
    {
      label: 'Net debt',
      entry: formatMoneyM(entry?.netDebt ?? null),
      current: formatMoneyM(current?.netDebt ?? null),
      change: formatSignedMoneyM(growth.netDebtChange),
    },
    {
      label: 'Equity value',
      entry: formatMoneyM(entry?.equityValue ?? null),
      current: formatMoneyM(current?.equityValue ?? null),
      change: formatPct(growth.equityValueGrowth),
    },
    {
      label: 'EV / EBITDA',
      entry: formatMultiple(entry?.evToEbitda ?? null),
      current: formatMultiple(current?.evToEbitda ?? null),
      change: formatSignedTurns(growth.multipleChange),
    },
    {
      label: 'Net debt / EBITDA',
      entry: formatMultiple(entry?.netDebtToEbitda ?? null),
      current: formatMultiple(current?.netDebtToEbitda ?? null),
      change: formatSignedTurns(growth.netLeverageChange),
    },
  ];
  return (
    <TableWrap label="Entry against current">
      <table className="pb-table" aria-label="Entry against current">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">
              {entry === null ? 'Entry' : `Entry, ${formatDate(entry.periodEnd)}`}
            </th>
            <th className="num">
              {current === null ? 'Current' : `Current, ${formatDate(current.periodEnd)}`}
            </th>
            <th className="num">Change since entry</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <NumCell>{r.entry}</NumCell>
              <NumCell>{r.current}</NumCell>
              <NumCell>{r.change}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * Value creation of one position (docs/04 M13 and M20, docs/08 section 8): the company's bridge
 * from the entry snapshot to the latest approved quarter, the indexed lines by quarter and entry
 * against current metrics. Equity and continuation vehicle positions only: for any other deal
 * type the API answers no row and the card shows nothing. A figure that is not calculable is the
 * missing placeholder with its reason, never a zero.
 */
export function ValueCreationCard({ id, company }: { id: string; company: string }): ReactNode {
  const q = useQuery(investmentValueCreationQuery(id));
  if (q.isPending) {
    return (
      <Card testId="deal-value-creation-loading">
        <PageSkeleton rows={3} />
      </Card>
    );
  }
  if (q.isError) {
    // Not found here means there is nothing of this position to show; the workspace says so itself.
    if (q.error instanceof ApiError && q.error.status === 404) return null;
    return (
      <Card testId="deal-value-creation">
        <SectionHeader>Value creation</SectionHeader>
        <UnavailableState inline error={q.error} subject="Value creation" />
      </Card>
    );
  }
  const p = q.data.position;
  if (p === null) return null;
  const span =
    p.entry !== null && p.current !== null
      ? `Entry snapshot ${formatDate(p.entry.periodEnd)} to ${formatDate(p.current.periodEnd)}`
      : `As of ${formatDate(q.data.asOf)}`;
  return (
    <Card testId="deal-value-creation">
      <SectionHeader aside={span}>Value creation</SectionHeader>
      <BridgeBlock p={p} company={company} />
      <OursLine p={p} />
      <div className="pb-deal-gap">
        <IndexedLines data={q.data} company={company} />
      </div>
      <EntryCurrentTable p={p} />
    </Card>
  );
}
