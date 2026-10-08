import { useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { AnalyticsSummary, ExposureBucket } from '@pb/contracts';
import { analyticsQuery } from '../../app/queries.js';
import { HorizontalBars, StackedBars } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  Field,
  NumCell,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, formatPct } from '../../lib/format.js';
import { DIMENSION_KEYS, DIMENSION_LABELS, isDimensionKey } from './constants.js';
import type { DimensionKey } from './constants.js';
import { bucketBars, vehicleDealTypeStack } from './helpers.js';

function BucketTable({ buckets, label }: { buckets: ExposureBucket[]; label: string }): ReactNode {
  return (
    <TableWrap label={`Exposure by ${label.toLowerCase()}`}>
      <table className="pb-table" aria-label={`Exposure by ${label.toLowerCase()}`}>
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Positions</th>
            <th className="num">Invested</th>
            <th className="num">NAV</th>
            <th className="num">Share of NAV</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.key}>
              <td>{b.label}</td>
              <td className="num">{b.count}</td>
              <NumCell>{formatMoneyM(b.invested)}</NumCell>
              <NumCell>{formatMoneyM(b.nav)}</NumCell>
              <NumCell>{formatPct(b.navShare)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** NAV per vehicle split by deal type: the API sums and orders it, the card only draws it. */
function VehicleDealTypeCard({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const breakdown = vehicleDealTypeStack(
    summary.exposures.vehicleByDealType,
    summary.exposures.dealType,
    summary.activeInvestments,
  );
  const first = breakdown.data[0];
  return (
    <Card>
      <SectionHeader>Vehicles</SectionHeader>
      {first === undefined ? (
        <EmptyState
          title="No Locked valuations"
          detail="The breakdown needs active positions with a Locked valuation."
        />
      ) : (
        <>
          <StackedBars
            title="NAV by vehicle and deal type"
            subtitle="Locked marks only"
            data={breakdown.data}
            segmentNames={breakdown.segmentNames}
            kind="money"
            summary={`NAV by vehicle split by deal type across ${breakdown.data.length} vehicles and ${breakdown.segmentNames.length} deal types; the largest vehicle is ${first.label}.`}
            testId="exposure-vehicle-deal-type"
          />
          {breakdown.excluded > 0 ? (
            <p className="pb-meta">
              {breakdown.excluded} active{' '}
              {breakdown.excluded === 1 ? 'position has' : 'positions have'} no Locked valuation and{' '}
              {breakdown.excluded === 1 ? 'is' : 'are'} not included.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

export function ExposureTab(): ReactNode {
  const [dimension, setDimension] = useState<DimensionKey>('sector');
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  if (analytics.isPending) return <PageSkeleton rows={6} />;
  if (analytics.isError) {
    return <UnavailableState error={analytics.error} subject="Portfolio analytics" />;
  }
  const summary = analytics.data;
  const label = DIMENSION_LABELS[dimension];
  const buckets = summary.exposures[dimension];
  const navBars = bucketBars(buckets, 'nav');
  const investedBars = bucketBars(buckets, 'invested');
  const largest = navBars[0];
  return (
    <>
      <Card>
        <SectionHeader
          aside={`As of ${formatDate(summary.asOf)}, ${summary.activeInvestments} active positions`}
        >
          Exposure
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="exposure-dimension">Dimension</Label>
            <Dropdown
              id="exposure-dimension"
              value={label}
              selectedOptions={[dimension]}
              onOptionSelect={(_e, d) => {
                if (d.optionValue !== undefined && isDimensionKey(d.optionValue)) {
                  setDimension(d.optionValue);
                }
              }}
            >
              {DIMENSION_KEYS.map((k) => (
                <Option key={k} value={k}>
                  {DIMENSION_LABELS[k]}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {largest === undefined ? (
          <EmptyState
            title="No active positions"
            detail="Exposure is measured over active positions and their Locked valuations."
          />
        ) : (
          <>
            <div className="pb-two-col">
              <HorizontalBars
                title={`NAV by ${label.toLowerCase()}`}
                subtitle="Locked marks only"
                data={navBars}
                kind="money"
                valueColumn="NAV"
                summary={`NAV by ${label.toLowerCase()} across ${navBars.length} buckets; the largest is ${largest.label} at ${largest.display}.`}
                testId="exposure-nav"
              />
              <HorizontalBars
                title={`Invested by ${label.toLowerCase()}`}
                subtitle="Contributions to date"
                data={investedBars}
                kind="money"
                valueColumn="Invested"
                summary={`Invested capital by ${label.toLowerCase()} across ${investedBars.length} buckets.`}
                testId="exposure-invested"
              />
            </div>
            <BucketTable buckets={buckets} label={label} />
          </>
        )}
      </Card>
      <VehicleDealTypeCard summary={summary} />
    </>
  );
}
