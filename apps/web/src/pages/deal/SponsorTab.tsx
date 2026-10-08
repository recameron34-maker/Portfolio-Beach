import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvestmentDetail, SponsorDetail } from '@pb/contracts';
import { sponsorQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import { formatMoic, formatMoneyM, labelOf, MISSING } from '../../lib/format.js';
import { useDealDetail } from './data.js';
import './deal.css';
import { balanceTiles } from '../../lib/tiles.js';

type SponsorFund = SponsorDetail['funds'][number];

function SponsorCard({ sponsor: s }: { sponsor: SponsorDetail }): ReactNode {
  return (
    <Card testId="deal-sponsor">
      <SectionHeader aside={`${s.fundCount} ${s.fundCount === 1 ? 'fund' : 'funds'} on record`}>
        Sponsor
      </SectionHeader>
      <p className="pb-deal-sponsor-name">
        <Link to="/sponsors/$id" params={{ id: s.id }}>
          {s.name}
        </Link>
        <Badge plain>{`${labelOf(s.tier)} tier`}</Badge>
      </p>
      <p className="pb-meta-list">
        <span>Headquarters {labelOf(s.hqGeography)}</span>
        <span>
          {s.activeInvestments} active {s.activeInvestments === 1 ? 'position' : 'positions'} with
          us
        </span>
      </p>
      {s.description !== null ? (
        <p className="pb-deal-sponsor-description">{s.description}</p>
      ) : (
        <p className="pb-meta pb-deal-note">No description on record.</p>
      )}
    </Card>
  );
}

function MetricsCard({ sponsor: s }: { sponsor: SponsorDetail }): ReactNode {
  const m = s.metrics;
  return (
    <Card testId="deal-sponsor-metrics">
      <SectionHeader aside="Pooled over the positions you can see">
        Across our positions with this sponsor
      </SectionHeader>
      <div ref={balanceTiles} className="pb-tiles pb-deal-tiles">
        <StatTile label="Positions" value={String(m.count)} hint="Active and realized" />
        <StatTile label="Invested" value={formatMoneyM(m.invested)} hint="Contributions to date" />
        <StatTile label="NAV" value={formatMoneyM(m.nav)} hint="Latest Locked valuations" />
        <StatTile
          label="Gross MOIC"
          value={formatMoic(m.grossMoic)}
          hint="(Distributions + NAV) / invested"
        />
      </div>
    </Card>
  );
}

/** Final size when the fund has closed; otherwise the target, marked as such. */
function SizeCell({ fund }: { fund: SponsorFund }): ReactNode {
  if (fund.sizeFinal !== null) return <NumCell>{formatMoneyM(fund.sizeFinal)}</NumCell>;
  if (fund.sizeTarget === null) return <NumCell>{MISSING}</NumCell>;
  return (
    <td className="num">
      {formatMoneyM(fund.sizeTarget)} <span className="pb-meta">target</span>
    </td>
  );
}

function FundsCard({
  sponsor: s,
  detail,
}: {
  sponsor: SponsorDetail;
  detail: InvestmentDetail;
}): ReactNode {
  return (
    <Card testId="deal-sponsor-funds">
      <SectionHeader aside="Our positions and commitments per fund">Funds</SectionHeader>
      {s.funds.length === 0 ? (
        <EmptyState
          title="No funds on record"
          detail="The sponsor's funds appear here with their vintage, strategy and size."
        />
      ) : (
        <TableWrap label="Sponsor funds">
          <table className="pb-table" aria-label="Sponsor funds">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Vintage</th>
                <th>Strategy</th>
                <th className="num">Size</th>
                <th className="num">Our positions</th>
                <th className="num">Our commitment</th>
              </tr>
            </thead>
            <tbody>
              {s.funds.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className="pb-deal-period">
                      {f.name}
                      {f.id === detail.sponsorFundId ? (
                        <Badge tone="brand">This position</Badge>
                      ) : null}
                    </span>
                  </td>
                  <NumCell>{f.vintage === null ? MISSING : String(f.vintage)}</NumCell>
                  <td>{labelOf(f.strategy)}</td>
                  <SizeCell fund={f} />
                  <NumCell>{String(f.ourPositions)}</NumCell>
                  <NumCell>{formatMoneyM(f.ourCommitment)}</NumCell>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function OtherPositionsCard({
  sponsor: s,
  detail,
}: {
  sponsor: SponsorDetail;
  detail: InvestmentDetail;
}): ReactNode {
  const others = s.positions.filter((p) => p.id !== detail.id);
  return (
    <Card testId="deal-sponsor-positions">
      <SectionHeader aside={others.length > 0 ? `${others.length} positions` : undefined}>
        Other positions with this sponsor
      </SectionHeader>
      {others.length === 0 ? (
        <EmptyState
          title="No other positions with this sponsor"
          detail="This is the only position with this sponsor that you can see."
        />
      ) : (
        <ul className="pb-linklist pb-deal-stacked" aria-label="Other positions with this sponsor">
          {others.map((p) => (
            <li key={p.id}>
              <span className="pb-deal-period">
                <Link to="/portfolio/$id" params={{ id: p.id }}>
                  {p.companyName}
                </Link>
                {p.isActive ? null : <Badge tone="neutral">Realized</Badge>}
              </span>
              <span className="pb-meta">
                {p.vehicleName}, {labelOf(p.dealType)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ContactsCard(): ReactNode {
  return (
    <Card testId="deal-contacts">
      <SectionHeader>Contacts and interactions</SectionHeader>
      <EmptyState
        title="Contacts and interactions arrive with M6 in Phase 5"
        detail="Relationship score, warm paths and coverage for this sponsor will show here."
      />
    </Card>
  );
}

/**
 * Sponsor and contacts tab (docs/04 M6, Sponsor 360 in brief): who the sponsor is, how our
 * positions with them have done, their funds, and the other positions we hold with them.
 */
export function SponsorTab(): ReactNode {
  const detail = useDealDetail();
  const d = detail.data;
  const q = useQuery({ ...sponsorQuery(d?.sponsorId ?? ''), enabled: d !== undefined });
  if (d === undefined) return detail.isPending ? <PageSkeleton tiles={4} rows={4} /> : null;
  if (q.isPending) return <PageSkeleton tiles={4} rows={4} />;
  if (q.isLoadingError) {
    return (
      <>
        <UnavailableState
          card
          error={q.error}
          subject="The sponsor"
          errorTitle="The sponsor could not load"
          testId="deal-sponsor-unavailable"
        />
        <ContactsCard />
      </>
    );
  }
  const s = q.data;
  return (
    <>
      <SponsorCard sponsor={s} />
      <MetricsCard sponsor={s} />
      <FundsCard sponsor={s} detail={d} />
      <div className="pb-two-col">
        <OtherPositionsCard sponsor={s} detail={d} />
        <ContactsCard />
      </div>
    </>
  );
}
