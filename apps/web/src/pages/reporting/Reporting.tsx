import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import { Print20Regular } from '@fluentui/react-icons';
import type { WeeklyReport } from '@pb/contracts';
import { REPORTING_TABS } from '../../app/nav.js';
import { weeklyReportQuery } from '../../app/queries.js';
import { ClientLookThrough } from '../../components/ClientLookThrough.js';
import {
  AiDraftBadge,
  Badge,
  Card,
  EmptyState,
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
} from '../../lib/format.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { humanizeState, noticeTone } from '../../lib/states.js';
import { changeBadge } from './report-ui.js';

function SummaryTiles({ report }: { report: WeeklyReport }): ReactNode {
  const s = report.summary;
  return (
    <div className="pb-tiles" data-testid="weekly-tiles">
      <StatTile label="Active positions" value={String(s.activeInvestments)} />
      <StatTile label="Invested" value={formatMoneyM(s.invested)} />
      <StatTile label="Distributions" value={formatMoneyM(s.distributions)} />
      <StatTile label="NAV" value={formatMoneyM(s.nav)} hint="Latest Locked valuations" />
      <StatTile label="DPI" value={formatMoic(s.dpi)} hint="Distributions / invested" />
      <StatTile label="TVPI" value={formatMoic(s.tvpi)} hint="(Distributions + NAV) / invested" />
      <StatTile label="Gross MOIC" value={formatMoic(s.grossMoic)} />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(s)}
        hint={s.irrFlag === null ? 'Pooled cash flows' : `Flag: ${s.irrFlag.replace(/_/g, ' ')}`}
      />
    </div>
  );
}

function ByVehicle({ report }: { report: WeeklyReport }): ReactNode {
  const s = report.summary;
  return (
    <Card>
      <SectionHeader aside={`${report.byVehicle.length} vehicles with active positions`}>
        By vehicle
      </SectionHeader>
      {report.byVehicle.length === 0 ? (
        <EmptyState
          title="No active positions"
          detail="No vehicle you can see holds an active position as of this date."
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="By vehicle">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Type</th>
                <th className="num">Positions</th>
                <th className="num">Invested</th>
                <th className="num">Distributions</th>
                <th className="num">NAV</th>
                <th className="num">Gross MOIC</th>
              </tr>
            </thead>
            <tbody>
              {report.byVehicle.map((v) => (
                <tr key={v.vehicleId}>
                  <td>{v.vehicleName}</td>
                  <td>{labelOf(v.vehicleType)}</td>
                  <NumCell>{String(v.count)}</NumCell>
                  <NumCell>{formatMoneyM(v.invested)}</NumCell>
                  <NumCell>{formatMoneyM(v.distributions)}</NumCell>
                  <NumCell>{formatMoneyM(v.nav)}</NumCell>
                  <NumCell>{formatMoic(v.grossMoic)}</NumCell>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td />
                <NumCell>{String(s.activeInvestments)}</NumCell>
                <NumCell>{formatMoneyM(s.invested)}</NumCell>
                <NumCell>{formatMoneyM(s.distributions)}</NumCell>
                <NumCell>{formatMoneyM(s.nav)}</NumCell>
                <NumCell>{formatMoic(s.grossMoic)}</NumCell>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Movers({ report }: { report: WeeklyReport }): ReactNode {
  return (
    <Card>
      <SectionHeader aside="Locked fair value against the prior quarter end">Movers</SectionHeader>
      {report.movers.length === 0 ? (
        <EmptyState
          title="No movers"
          detail="No position has a Locked valuation for both the period end and the prior quarter end, so no change is calculable."
          testId="movers-empty"
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="Movers">
            <thead>
              <tr>
                <th>Investment</th>
                <th>Period</th>
                <th className="num">Prior fair value</th>
                <th className="num">Fair value</th>
                <th className="num">Change</th>
                <th>Direction</th>
              </tr>
            </thead>
            <tbody>
              {report.movers.map((m) => {
                const badge = changeBadge(m.changePct);
                return (
                  <tr key={m.investmentId}>
                    <td>
                      <span className="pb-key">{m.investmentNumber}</span> {m.companyName}
                    </td>
                    <td>{formatDate(m.periodEnd)}</td>
                    <NumCell>{formatMoneyM(m.priorFairValue)}</NumCell>
                    <NumCell>{formatMoneyM(m.fairValue)}</NumCell>
                    <NumCell>{formatPct(m.changePct)}</NumCell>
                    <td>
                      {badge === null ? MISSING : <Badge tone={badge.tone}>{badge.word}</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StaleValuations({ report }: { report: WeeklyReport }): ReactNode {
  const items = report.staleValuations;
  return (
    <Card>
      <SectionHeader
        aside={`${items.length} of ${report.summary.activeInvestments} active positions`}
      >
        Stale valuations
      </SectionHeader>
      {items.length === 0 ? (
        <p className="pb-chips">
          <Badge tone="good">All current</Badge>
          <span className="pb-meta">
            Every active position has a Locked valuation for {formatDate(report.periodEnd)}.
          </span>
        </p>
      ) : (
        <ul className="pb-list" data-testid="stale-list">
          {items.map((s) => (
            <li key={s.investmentId}>
              <span className="pb-key">{s.investmentNumber}</span> {s.companyName}: {s.footnote}
              {s.latestLockedPeriodEnd === null ? null : (
                <span className="pb-meta">
                  {' '}
                  Latest Locked {formatDate(s.latestLockedPeriodEnd)}.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CapitalActivity({ report }: { report: WeeklyReport }): ReactNode {
  const rows = report.capitalActivity;
  return (
    <Card>
      <SectionHeader aside="Open notices and those due around the as-of date">
        Capital activity
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No capital activity"
          detail="No notice is open or due within the reporting window."
          testId="capital-empty"
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="Capital activity">
            <thead>
              <tr>
                <th>Type</th>
                <th>Company or fund</th>
                <th>Vehicle</th>
                <th>Due</th>
                <th className="num">Amount</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td>{labelOf(n.noticeType)}</td>
                  <td>{n.companyName ?? n.sponsorFundName ?? MISSING}</td>
                  <td>{n.vehicleName}</td>
                  <td>
                    {formatDate(n.dueDate)}
                    {n.daysToDue < 0 ? <span className="pb-meta"> (overdue)</span> : null}
                  </td>
                  <NumCell>{formatMoneyM(n.amount)}</NumCell>
                  <td>
                    <Badge tone={noticeTone(n.state)}>{humanizeState(n.state)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Commentary({ report }: { report: WeeklyReport }): ReactNode {
  const c = report.commentary;
  return (
    <Card>
      <SectionHeader aside={c.aiDraft ? <AiDraftBadge /> : undefined}>Commentary</SectionHeader>
      {c.paragraphs.length === 0 ? (
        <p className="pb-meta">No commentary for this period.</p>
      ) : (
        <div className="pb-prose" data-testid="commentary">
          {c.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {c.source === 'template' ? (
        <p className="pb-meta" data-testid="commentary-source">
          Assembled from the figures above by a template; no model was called.
        </p>
      ) : null}
    </Card>
  );
}

function Footnotes({ report }: { report: WeeklyReport }): ReactNode {
  return (
    <Card>
      <SectionHeader>Footnotes</SectionHeader>
      {report.footnotes.length === 0 ? (
        <p className="pb-meta">No footnotes.</p>
      ) : (
        <ol className="pb-list" data-testid="footnotes">
          {report.footnotes.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ol>
      )}
      <p className="pb-meta">
        Calculation version {report.calcVersion}. Figures cover the positions you are entitled to
        see.
      </p>
    </Card>
  );
}

/** The weekly portfolio report assembled by the API from approved figures (M12), laid out to print. */
export function WeeklyReportPage(): ReactNode {
  const q = useQuery({ ...weeklyReportQuery, placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton tiles={8} rows={6} />;
  if (q.isError) {
    return (
      <UnavailableState
        card
        subject="The weekly report"
        error={q.error}
        forbidden={{
          title: 'The weekly report is not available to your role',
          detail: 'It is assembled from the positions each reader is entitled to see.',
        }}
        notReady={{ title: 'The weekly report is not available yet' }}
        errorTitle="Weekly report unavailable"
      />
    );
  }
  const r = q.data;
  return (
    <div className="pb-report">
      <PageHeader
        title="Weekly portfolio report"
        testId="weekly-header"
        meta={
          <>
            Period {formatDate(r.periodEnd)}, as of {formatDate(r.asOf)}, prepared for{' '}
            {r.preparedFor}
          </>
        }
        actions={
          <span className="pb-report-actions pb-no-print">
            <span className="pb-meta">
              PowerPoint, Word and Excel output arrives in Phase 4 (M12, M14)
            </span>
            <Button size="small" icon={<Print20Regular />} onClick={() => window.print()}>
              Print
            </Button>
          </span>
        }
      />
      <div className="pb-no-print">
        <TabNav label="Reporting" items={REPORTING_TABS} />
      </div>
      <SummaryTiles report={r} />
      <ByVehicle report={r} />
      <Movers report={r} />
      <StaleValuations report={r} />
      <CapitalActivity report={r} />
      <Commentary report={r} />
      <Footnotes report={r} />
    </div>
  );
}

/** Client look-through (docs/03 section 4): the same component the Analytics Clients tab renders. */
export function ClientsPage(): ReactNode {
  return (
    <>
      <PageHeader
        title="Clients"
        meta="Shares are the vehicle's pooled figures times the client's ownership percentage (docs/03 section 4)."
      />
      <TabNav label="Reporting" items={REPORTING_TABS} />
      <ClientLookThrough />
    </>
  );
}

/** Disclosures arrive with M19; the page keeps the phase placeholder and says what the module will hold. */
export function DisclosuresPage(): ReactNode {
  return (
    <>
      <PageHeader
        title="Disclosures and statistics"
        meta="Phase 4: M19 disclosures and approved statistics"
      />
      <TabNav label="Reporting" items={REPORTING_TABS} />
      <Card>
        <EmptyState
          title="Disclosures and statistics arrives in Phase 4"
          detail="The data model and workflow for this area are specified (docs/04, docs/18); the screens are built once the earlier phases pass their exit criteria."
        />
        <div className="pb-prose">
          <p>
            M19 will hold the versioned disclosure library that report templates reference by id,
            the approved statistics register (value, as-of date, source query, approver and expiry)
            and the automatic stale-valuation footnotes. It will also record affiliated-party
            consents, which block a closing until recorded, and the distribution log of every issued
            report.
          </p>
        </div>
      </Card>
    </>
  );
}
