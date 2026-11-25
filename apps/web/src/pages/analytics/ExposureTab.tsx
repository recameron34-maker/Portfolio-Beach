import { useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import type { AnalyticsSummary, ExposureBucket } from '@pb/contracts';
import { analyticsQuery } from '../../app/queries.js';
import { HorizontalBars, SharedScale, StackedBars } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  Field,
  NumCell,
  PageContext,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, formatPct, plural } from '../../lib/format.js';
import { useNarrowScreen } from '../../lib/media.js';
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
      {/* The chart is all the section holds, so its title is the section's. */}
      <SectionHeader>NAV by vehicle and deal type</SectionHeader>
      {first === undefined ? (
        <EmptyState
          title="No Locked valuations"
          detail="The breakdown needs active positions with a Locked valuation."
        />
      ) : (
        <>
          <StackedBars
            title="NAV by vehicle and deal type"
            hideCaption
            data={breakdown.data}
            segmentNames={breakdown.segmentNames}
            kind="money"
            summary={`NAV by vehicle split by deal type across ${plural(breakdown.data.length, 'vehicle')} and ${plural(breakdown.segmentNames.length, 'deal type')}; the largest vehicle is ${first.label}.`}
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

/**
 * How the exposure is grouped: one choice of six, side by side from a laptop up; on a phone, where
 * six would not fit on a line, the same choice from a list.
 */
function GroupBy({
  dimension,
  onChange,
}: {
  dimension: DimensionKey;
  onChange: (next: DimensionKey) => void;
}): ReactNode {
  const narrow = useNarrowScreen();
  if (narrow) {
    return (
      <Field>
        <Label htmlFor="exposure-dimension">Group by</Label>
        <Dropdown
          id="exposure-dimension"
          value={DIMENSION_LABELS[dimension]}
          selectedOptions={[dimension]}
          onOptionSelect={(_e, d) => {
            if (d.optionValue !== undefined && isDimensionKey(d.optionValue))
              onChange(d.optionValue);
          }}
        >
          {DIMENSION_KEYS.map((k) => (
            <Option key={k} value={k}>
              {DIMENSION_LABELS[k]}
            </Option>
          ))}
        </Dropdown>
      </Field>
    );
  }
  return (
    <span className="pb-analytics-group-by">
      <span className="pb-analytics-control-label" id="exposure-group-by">
        Group by
      </span>
      <span className="pb-segmented" role="group" aria-labelledby="exposure-group-by">
        {DIMENSION_KEYS.map((k) => (
          <button key={k} type="button" aria-pressed={k === dimension} onClick={() => onChange(k)}>
            {DIMENSION_LABELS[k]}
          </button>
        ))}
      </span>
    </span>
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
      <PageContext
        heading="Exposure"
        items={[
          `As of ${formatDate(summary.asOf)}`,
          plural(summary.activeInvestments, 'active position'),
          'Locked marks only',
        ]}
        controls={<GroupBy dimension={dimension} onChange={setDimension} />}
      />
      <Card>
        {largest === undefined ? (
          <EmptyState
            title="No active positions"
            detail="Exposure is measured over active positions and their Locked valuations."
          />
        ) : (
          <>
            <div className="pb-two-col pb-analytics-pair">
              <SharedScale>
                <HorizontalBars
                  title={`NAV by ${label.toLowerCase()}`}
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
              </SharedScale>
            </div>
            <BucketTable buckets={buckets} label={label} />
          </>
        )}
      </Card>
      <VehicleDealTypeCard summary={summary} />
    </>
  );
}
