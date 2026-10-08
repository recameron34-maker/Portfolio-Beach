import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Input, Label } from '@fluentui/react-components';
import { ChevronLeft16Regular, Search16Regular } from '@fluentui/react-icons';
import type { SponsorDetail, SponsorSummary } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { sponsorQuery, sponsorsQuery } from '../../app/queries.js';
import { HorizontalBars } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  Toolbar,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  irrDisplay,
  labelOf,
  MISSING,
} from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import {
  filterSponsors,
  fundSizeLabel,
  navByPosition,
  sponsorCountLabel,
  tierTone,
} from './sponsor-ui.js';
import './sponsors.css';

/* ---- Sponsors directory (/sponsors) ---- */

function SponsorsTable({ items }: { items: SponsorSummary[] }): ReactNode {
  return (
    <div className="pb-table-wrap">
      <table className="pb-table" aria-label="Sponsors">
        <thead>
          <tr>
            <th>Name</th>
            <th>Tier</th>
            <th>HQ</th>
            <th className="num">Funds</th>
            <th className="num">Active positions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td className="pb-nowrap">
                <Link to="/sponsors/$id" params={{ id: s.id }}>
                  {s.name}
                </Link>
              </td>
              <td>
                <Badge plain tone={tierTone(s.tier)}>
                  {labelOf(s.tier)}
                </Badge>
              </td>
              <td className={s.hqGeography === null ? 'is-missing' : 'pb-nowrap'}>
                {labelOf(s.hqGeography)}
              </td>
              <NumCell>{String(s.fundCount)}</NumCell>
              <NumCell>{String(s.activeInvestments)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SponsorDirectory({ items, more }: { items: SponsorSummary[]; more: boolean }): ReactNode {
  const [search, setSearch] = useState('');
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No sponsors visible"
          detail="Sponsors appear here once operations adds them."
          testId="sponsors-empty"
        />
      </Card>
    );
  }
  const shown = filterSponsors(items, search);
  return (
    <Card>
      <SectionHeader>Directory</SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor="sponsor-search">Search</Label>
          <Input
            id="sponsor-search"
            contentBefore={<Search16Regular />}
            placeholder="Sponsor name"
            value={search}
            onChange={(_e, d) => setSearch(d.value)}
          />
        </Field>
      </Toolbar>
      {shown.length === 0 ? (
        <EmptyState
          title={`No sponsor matches "${search.trim()}"`}
          detail="Clear the search to see every sponsor."
          testId="sponsors-no-match"
        />
      ) : (
        <SponsorsTable items={shown} />
      )}
      <p className="pb-meta pb-sponsors-note" data-testid="sponsors-count">
        {sponsorCountLabel(shown.length, items.length)}
        {more ? `. Only the first ${items.length} are listed; more sponsors exist.` : null}
      </p>
    </Card>
  );
}

/** The sponsor directory (M6): firm-side data only until contacts and interactions arrive in Phase 5. */
export function SponsorsPage(): ReactNode {
  const q = useQuery({ ...sponsorsQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton rows={8} />;
  return (
    <>
      <PageHeader
        title="Sponsors"
        meta="Firm-side data only in the prototype. Contacts, interactions and the relationship score arrive with M6 in Phase 5."
      />
      {q.isError ? (
        <UnavailableState card error={q.error} subject="Sponsors" testId="sponsors-unavailable" />
      ) : (
        <SponsorDirectory items={q.data.items} more={q.data.nextCursor !== null} />
      )}
    </>
  );
}

/* ---- Sponsor 360 (/sponsors/$id) ---- */

function BackToSponsors(): ReactNode {
  return (
    <p className="pb-sponsors-back">
      <Link to="/sponsors">
        <ChevronLeft16Regular />
        All sponsors
      </Link>
    </p>
  );
}

function StatusBadge({ active }: { active: boolean }): ReactNode {
  return active ? <Badge tone="brand">Active</Badge> : <Badge tone="neutral">Realized</Badge>;
}

function CommittedTile({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const n = sponsor.commitments.length;
  return (
    <StatTile
      label="Committed"
      value={formatMoneyM(sponsor.totalCommitted)}
      hint={
        n === 0 ? 'No commitments to its funds' : `${n} ${n === 1 ? 'commitment' : 'commitments'}`
      }
    />
  );
}

/**
 * Pooled figures over our positions with the sponsor plus our commitments to its funds. Without a
 * visible position nothing pools, so only the count and the commitments show (no blank tiles).
 */
function SponsorTiles({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const m = sponsor.metrics;
  if (m.count === 0) {
    return (
      <div className="pb-tiles pb-sponsors-tiles" data-testid="sponsor-tiles">
        <StatTile label="Positions" value="0" hint="No positions with this sponsor" />
        <CommittedTile sponsor={sponsor} />
      </div>
    );
  }
  return (
    <div className="pb-tiles pb-sponsors-tiles" data-testid="sponsor-tiles">
      <StatTile
        label="Positions"
        value={String(m.count)}
        hint={`${sponsor.activeInvestments} active`}
      />
      <StatTile label="Invested" value={formatMoneyM(m.invested)} hint="Contributions to date" />
      <StatTile label="NAV" value={formatMoneyM(m.nav)} hint="Locked marks only" />
      <StatTile
        label="Gross MOIC"
        value={formatMoic(m.grossMoic)}
        hint="(Distributions + NAV) / invested"
      />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(m)}
        hint={irrFlagHint(m.irrFlag) ?? 'Pooled cash flows, XIRR'}
      />
      <CommittedTile sponsor={sponsor} />
    </div>
  );
}

/** NAV per active position. sponsors.css hides it below 440 pixels, where the positions table carries the same NAVs. */
function ExposureCard({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const { bars, withoutNav } = navByPosition(sponsor.positions);
  const top = bars[0];
  return (
    <div className="pb-sponsors-exposure">
      <Card>
        <SectionHeader aside="Active positions">Exposure</SectionHeader>
        {top === undefined ? (
          <EmptyState
            title="No active position with a NAV"
            detail="NAV by position appears once an active position with this sponsor has a Locked valuation."
            testId="sponsor-nav-empty"
          />
        ) : (
          <HorizontalBars
            title="NAV by position"
            subtitle="Locked marks only"
            data={bars}
            kind="money"
            valueColumn="NAV"
            summary={`NAV by position across ${bars.length} active ${bars.length === 1 ? 'position' : 'positions'}; the largest is ${top.label} at ${top.display}.`}
            testId="sponsor-nav-by-position"
          />
        )}
        {withoutNav > 0 ? (
          <p className="pb-meta pb-sponsors-note">
            {withoutNav} active {withoutNav === 1 ? 'position has' : 'positions have'} no Locked
            valuation and {withoutNav === 1 ? 'is' : 'are'} not shown.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function FundsCard({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const funds = sponsor.funds;
  return (
    <Card>
      <SectionHeader
        aside={
          funds.length === 0
            ? undefined
            : "Sizes in each fund's own currency; holdings from look-through data"
        }
      >
        Funds
      </SectionHeader>
      {funds.length === 0 ? (
        <EmptyState
          title="No funds recorded"
          detail="Funds this sponsor raises appear here once operations records them."
          testId="sponsor-funds-empty"
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="Funds">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Vintage</th>
                <th>Strategy</th>
                <th className="num">Target size</th>
                <th className="num">Final size</th>
                <th>Aliases</th>
                <th className="num">Holdings</th>
                <th className="num">Our positions</th>
                <th className="num">Our commitment</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((f) => (
                <tr key={f.id}>
                  <td className="pb-nowrap">{f.name}</td>
                  <NumCell>{f.vintage === null ? MISSING : String(f.vintage)}</NumCell>
                  <td>{labelOf(f.strategy)}</td>
                  <NumCell>{fundSizeLabel(f.sizeTarget, f.currency)}</NumCell>
                  <NumCell>{fundSizeLabel(f.sizeFinal, f.currency)}</NumCell>
                  <td>
                    {f.aliases.length === 0 ? (
                      <span className="pb-meta">None</span>
                    ) : (
                      <span className="pb-chips pb-sponsors-aliases">
                        {f.aliases.map((a) => (
                          <Badge key={a} plain tone="neutral">
                            {a}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                  <NumCell>{String(f.holdings)}</NumCell>
                  <NumCell>{String(f.ourPositions)}</NumCell>
                  <NumCell>{formatMoneyM(f.ourCommitment)}</NumCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PositionsCard({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const positions = sponsor.positions;
  const m = sponsor.metrics;
  return (
    <Card>
      <SectionHeader
        aside={
          positions.length === 0
            ? undefined
            : `${positions.length} ${positions.length === 1 ? 'position' : 'positions'}, ${sponsor.activeInvestments} active`
        }
      >
        Our positions
      </SectionHeader>
      {positions.length === 0 ? (
        <EmptyState
          title="No positions with this sponsor"
          detail="Positions appear here once one of our vehicles invests in a deal this sponsor leads."
          testId="sponsor-positions-empty"
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table pb-sponsors-table" aria-label="Our positions">
            <thead>
              <tr>
                <th>Inv #</th>
                <th>Company and vehicle</th>
                <th>Deal type</th>
                <th>Entry</th>
                <th className="num">Invested</th>
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
                    <span className="pb-sponsors-sub">{p.vehicleName}</span>
                  </td>
                  <td>{labelOf(p.dealType)}</td>
                  <td className="pb-nowrap">{formatDate(p.entryDate)}</td>
                  <NumCell>{formatMoneyM(p.invested)}</NumCell>
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
                <NumCell>{formatMoneyM(m.invested)}</NumCell>
                <NumCell>{formatMoneyM(m.nav)}</NumCell>
                <NumCell>{formatMoic(m.grossMoic)}</NumCell>
                <NumCell>{irrDisplay(m)}</NumCell>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function CommitmentsCard({ sponsor }: { sponsor: SponsorDetail }): ReactNode {
  const rows = sponsor.commitments;
  const withClient = rows.some((c) => c.clientName !== null);
  const noFlows = rows.some((c) => c.called === null || c.unfunded === null);
  return (
    <Card>
      <SectionHeader
        aside={rows.length === 0 ? undefined : "Our vehicles' commitments to this sponsor's funds"}
      >
        Commitments
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No commitments to this sponsor's funds"
          detail="Commitments from the primary program or a client account appear here."
          testId="sponsor-commitments-empty"
        />
      ) : (
        <>
          <div className="pb-table-wrap">
            <table className="pb-table pb-sponsors-table" aria-label="Commitments">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Sponsor fund</th>
                  {withClient ? <th>Client</th> : null}
                  <th className="num">Committed</th>
                  <th className="num">Called</th>
                  <th className="num">Unfunded</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="pb-nowrap">
                      <Link to="/portfolio/vehicles/$id" params={{ id: c.vehicleId }}>
                        {c.vehicleName}
                      </Link>
                    </td>
                    <td className="pb-nowrap">{c.sponsorFundName}</td>
                    {withClient ? (
                      <td className={c.clientName === null ? 'is-missing' : 'pb-nowrap'}>
                        {c.clientName ?? MISSING}
                      </td>
                    ) : null}
                    <NumCell>{formatMoneyM(c.amount)}</NumCell>
                    <NumCell>{formatMoneyM(c.called)}</NumCell>
                    <NumCell>{formatMoneyM(c.unfunded)}</NumCell>
                    <td className="pb-nowrap">{formatDate(c.commitmentDate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={withClient ? 3 : 2}>
                    Total
                  </th>
                  <NumCell>{formatMoneyM(sponsor.totalCommitted)}</NumCell>
                  <td />
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {noFlows ? (
            <p className="pb-meta pb-sponsors-note">
              A commitment with no recorded cash flow yet shows the missing placeholder ({MISSING})
              for called and unfunded.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function SponsorUnavailable({ error }: { error: Error }): ReactNode {
  const hidden = error instanceof ApiError && (error.status === 404 || error.status === 403);
  return (
    <>
      <BackToSponsors />
      {hidden ? (
        <ErrorState
          title="Sponsor not found or not visible to you"
          detail="Check the link, or open the sponsor from the directory."
        />
      ) : (
        <UnavailableState
          card
          error={error}
          subject="This sponsor"
          errorTitle="Could not load this sponsor"
        />
      )}
    </>
  );
}

/** Sponsor 360 (docs/04 M6): funds, our positions and commitments; contacts and interactions follow in Phase 5. */
export function SponsorDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/sponsors/$id' });
  const q = useQuery(sponsorQuery(id));
  if (q.isPending) return <PageSkeleton tiles={6} rows={6} />;
  if (q.isError) return <SponsorUnavailable error={q.error} />;
  const s = q.data;
  return (
    <>
      <BackToSponsors />
      <PageHeader
        testId="sponsor-banner"
        title={s.name}
        meta={
          <span className="pb-meta-list">
            <span>{labelOf(s.tier)} tier</span>
            <span>
              {s.hqGeography === null ? 'HQ not recorded' : `HQ ${labelOf(s.hqGeography)}`}
            </span>
            <span>
              {s.fundCount} {s.fundCount === 1 ? 'fund' : 'funds'}
            </span>
          </span>
        }
      />
      {s.description !== null ? (
        <p className="pb-sponsors-lead" data-testid="sponsor-description">
          {s.description}
        </p>
      ) : null}
      <SponsorTiles sponsor={s} />
      {s.positions.length > 0 ? <ExposureCard sponsor={s} /> : null}
      <FundsCard sponsor={s} />
      <PositionsCard sponsor={s} />
      <CommitmentsCard sponsor={s} />
      <Card testId="sponsor-relationship">
        <SectionHeader>Contacts and interactions</SectionHeader>
        <EmptyState
          title="Contacts and interactions arrive with M6 in Phase 5"
          detail="That release adds the relationship score, warm paths, coverage and AGM notes."
        />
      </Card>
      <p className="pb-meta" data-testid="sponsor-calc-version">
        Calc version {s.calcVersion}.
      </p>
    </>
  );
}
