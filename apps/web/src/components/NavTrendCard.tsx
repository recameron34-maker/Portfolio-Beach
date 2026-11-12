import type { ReactNode } from 'react';
import type { SeriesPoint } from '@pb/contracts';
import { formatMoneyM, formatQuarter, joinList, moneyLabel, plural } from '../lib/format.js';
import { LineChart } from './charts/index.js';
import { Card, EmptyState, SectionHeader } from './ui.js';

/** Quarters the note under the chart names one by one; more than this are counted instead. */
const NAMED_GAPS = 3;

/**
 * NAV by quarter wherever the app charts it (Home, Analytics > Performance, a vehicle), from the
 * API's one series rule: every position held at a quarter end at its latest Locked mark (docs/08
 * section 2). A quarter in which a held position has no Locked mark yet is not calculable: the
 * line breaks there and the note under the chart names it, never a partial sum or the nearest
 * quarter's figure (CLAUDE.md rule 10). Two calculable quarters are the least that makes a trend.
 */
export function NavTrendCard({
  points,
  heading = 'NAV trend',
  testId,
  emptyTestId,
}: {
  points: readonly SeriesPoint[];
  heading?: string | undefined;
  testId: string;
  emptyTestId?: string | undefined;
}): ReactNode {
  const known = points.filter((p): p is SeriesPoint & { value: string } => p.value !== null);
  const first = known[0];
  const last = known[known.length - 1];
  const gaps = points.filter((p) => p.value === null).map((p) => formatQuarter(p.periodEnd));
  const gapWords =
    gaps.length === 0
      ? null
      : `Not calculable for ${gaps.length <= NAMED_GAPS ? joinList(gaps) : plural(gaps.length, 'quarter')}`;
  return (
    <Card>
      <SectionHeader aside="Positions held at each quarter end">{heading}</SectionHeader>
      {known.length < 2 || first === undefined || last === undefined ? (
        <EmptyState
          title="No NAV trend yet"
          detail="The trend needs at least two quarters in which every position held has a Locked mark."
          testId={emptyTestId}
        />
      ) : (
        <>
          <LineChart
            title="NAV by quarter"
            subtitle={`Each at its latest Locked mark, last ${plural(points.length, 'quarter')}`}
            x={points.map((p) => formatQuarter(p.periodEnd))}
            series={[
              {
                name: 'NAV',
                values: points.map((p) => (p.value === null ? null : Number(p.value))),
              },
            ]}
            kind="money"
            format={moneyLabel}
            summary={`NAV by quarter over ${plural(points.length, 'quarter')}, from ${formatMoneyM(first.value)} in ${formatQuarter(first.periodEnd)} to ${formatMoneyM(last.value)} in ${formatQuarter(last.periodEnd)}.${gapWords === null ? '' : ` ${gapWords}.`}`}
            testId={testId}
          />
          {gapWords === null ? null : (
            <p className="pb-meta" data-testid={`${testId}-gaps`}>
              {gapWords}: a position held then had no Locked mark for that quarter or an earlier
              one.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
