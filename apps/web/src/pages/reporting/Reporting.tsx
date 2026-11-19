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
  EmptyLine,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
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
  plural,
} from '../../lib/format.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { dueLabel, humanizeState, noticeTone } from '../../lib/states.js';
import { isSettled } from '../capital/notices.js';
import { changeBadge } from './report-ui.js';
import { balanceTiles } from '../../lib/tiles.js';
import './reporting.css';

function SummaryTiles({ report }: { report: WeeklyReport }): ReactNode {
  const s = report.summary;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="weekly-tiles">
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
      <SectionHeader aside={`${plural(report.byVehicle.length, 'vehicle')} with active positions`}>
        By vehicle
      </SectionHeader>
      {report.byVehicle.length === 0 ? (
        <EmptyLine
          title="No active positions"
          detail="No vehicle you can see holds an active position as of this date."
        />
      ) : (
        <TableWrap label="By vehicle">
          <table className="pb-table" aria-label="By vehicle">
            <thead>
              <tr>
                <th>Vehicle</th>
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
                  <td className="pb-col-text">
                    {v.vehicleName}
                    <span className="pb-cell-sub">{labelOf(v.vehicleType)}</span>
                  </td>
                  <NumCell>{String(v.count)}</NumCell>
                  <NumCell>{formatMoneyM(v.invested)}</NumCell>
                  <NumCell>{formatMoneyM(v.distributions)}</NumCell>
                  <NumCell>{formatMoneyM(v.nav)}</NumCell>
                  <NumCell>{formatMoic(v.grossMoic)}</NumCell>
                </tr>
              ))}
            </tbody>
            {/* The report's own totals, as the API gives them: the page adds nothing up. */}
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <NumCell>{String(s.activeInvestments)}</NumCell>
                <NumCell>{formatMoneyM(s.invested)}</NumCell>
                <NumCell>{formatMoneyM(s.distributions)}</NumCell>
                <NumCell>{formatMoneyM(s.nav)}</NumCell>
                <NumCell>{formatMoic(s.grossMoic)}</NumCell>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * Which way a mover went, in neutral words after a small mark: a fall in value is reported, not
 * alarmed, so the direction never takes a status colour. The mark is drawn, never read.
 */
const DIRECTION_MARKS: Readonly<Record<string, string>> = {
  Up: '4,0 8,7 0,7',
  Down: '0,0 8,0 4,7',
  Flat: '0,2.5 8,2.5 8,4.5 0,4.5',
};

function Direction({ word }: { word: string }): ReactNode {
  return (
    <span className="pb-direction">
      {/* A drawn shape, so it prints like the words beside it. */}
      <svg className="pb-direction-mark" viewBox="0 0 8 7" aria-hidden="true">
        <polygon points={DIRECTION_MARKS[word] ?? DIRECTION_MARKS.Flat} />
      </svg>
      {word}
    </span>
  );
}

function Movers({ report }: { report: WeeklyReport }): ReactNode {
  return (
    <Card>
      <SectionHeader aside="Locked fair value against the prior quarter end">Movers</SectionHeader>
      {report.movers.length === 0 ? (
        <EmptyLine
          title="No movers"
          detail="No position has a Locked valuation for both the period end and the prior quarter end, so no change is calculable."
          testId="movers-empty"
        />
      ) : (
        <TableWrap label="Movers">
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
                    <td className="pb-col-text">
                      <span className="pb-key">{m.investmentNumber}</span> {m.companyName}
                    </td>
                    <td className="pb-nowrap">{formatDate(m.periodEnd)}</td>
                    <NumCell>{formatMoneyM(m.priorFairValue)}</NumCell>
                    <NumCell>{formatMoneyM(m.fairValue)}</NumCell>
                    <NumCell>{formatPct(m.changePct)}</NumCell>
                    {badge === null ? (
                      <td className="is-missing">{MISSING}</td>
                    ) : (
                      <td>
                        <Direction word={badge.word} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function StaleValuations({ report }: { report: WeeklyReport }): ReactNode {
  const items = report.staleValuations;
  return (
    <Card>
      <SectionHeader
        aside={`${items.length} of ${plural(report.summary.activeInvestments, 'active position')}`}
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
        <EmptyLine
          title="No capital activity"
          detail="No notice is open or due within the reporting window."
          testId="capital-empty"
        />
      ) : (
        <TableWrap label="Capital activity">
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
                  <td className="pb-col-text">{n.companyName ?? n.sponsorFundName ?? MISSING}</td>
                  <td className="pb-col-text">{n.vehicleName}</td>
                  <td className="pb-nowrap">
                    {formatDate(n.dueDate)}
                    {/* The alert applies only until the money moves, as on the notice register. */}
                    {n.daysToDue < 0 && !isSettled(n.state) ? (
                      <span className="pb-cell-sub">
                        <Badge tone="bad">{dueLabel(n.daysToDue)}</Badge>
                      </span>
                    ) : null}
                  </td>
                  <NumCell>{formatMoneyM(n.amount)}</NumCell>
                  <td>
                    <Badge tone={noticeTone(n.state)}>{humanizeState(n.state)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
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
        <p className="pb-meta pb-report-source" data-testid="commentary-source">
          Written by a fixed template from the figures above.
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
      <p className="pb-meta pb-report-source">
        Calculation version {report.calcVersion}. Figures cover the positions you are entitled to
        see.
        <span className="pb-no-print"> PowerPoint, Word and Excel output is not built yet.</span>
      </p>
    </Card>
  );
}

/**
 * The weekly portfolio report assembled by the API from approved figures (M12), laid out to print.
 * The title and the tabs stay in place while it loads or cannot be shown, so the reader can leave
 * for another tab; the period, the date and whom it is for arrive with the report.
 */
export function WeeklyReportPage(): ReactNode {
  const q = useQuery({ ...weeklyReportQuery, placeholderData: keepPreviousData });
  const tabs = <TabNav label="Reporting" items={REPORTING_TABS} className="pb-no-print" />;
  if (q.isPending || q.isError) {
    return (
      <>
        <PageHeader title="Weekly portfolio report" testId="weekly-header" />
        {tabs}
        {q.isPending ? (
          <PageSkeleton tiles={8} rows={6} />
        ) : (
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
        )}
      </>
    );
  }
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Weekly portfolio report"
        testId="weekly-header"
        meta={
          <span className="pb-meta-list">
            <span>Period {formatDate(r.periodEnd)}</span>
            <span>As of {formatDate(r.asOf)}</span>
            <span>Prepared for {r.preparedFor}</span>
          </span>
        }
        actions={
          // The wrapper keeps the button off paper: the kit's own display rule outranks a class on it.
          <span className="pb-no-print">
            <Button size="small" icon={<Print20Regular />} onClick={() => window.print()}>
              Print
            </Button>
          </span>
        }
      />
      {tabs}
      <SummaryTiles report={r} />
      <ByVehicle report={r} />
      <Movers report={r} />
      <StaleValuations report={r} />
      <CapitalActivity report={r} />
      <Commentary report={r} />
      <Footnotes report={r} />
    </>
  );
}

/** Client look-through (docs/03 section 4): the same component the Analytics Clients tab renders. */
export function ClientsPage(): ReactNode {
  return (
    <>
      <PageHeader title="Clients" />
      <TabNav label="Reporting" items={REPORTING_TABS} />
      <ClientLookThrough
        note={"Shares are the vehicle's pooled figures times the client's ownership percentage."}
      />
    </>
  );
}

/** What the Disclosures page will hold once it is built (M19). */
const DISCLOSURES_PLANNED = [
  'The disclosure library: the approved wording that reports insert, with its versions.',
  'The register of approved statistics: each value with its as-of date, source, approver and expiry.',
  'Footnotes added on their own when a valuation is stale.',
  'Consents from affiliated parties, which block a closing until they are recorded.',
  'A log of every report sent.',
];

/** Disclosures arrive with M19; the page says so and what the module will hold. */
export function DisclosuresPage(): ReactNode {
  return (
    <>
      <PageHeader
        title="Disclosures and statistics"
        meta="The disclosure library and the register of approved statistics"
      />
      <TabNav label="Reporting" items={REPORTING_TABS} />
      <Card>
        <p className="pb-disclosures-state">
          <Badge>Not built yet</Badge>
          <span className="pb-meta">
            Disclosures and statistics is planned for a later release.
          </span>
        </p>
        <p className="pb-disclosures-lead">This page will hold:</p>
        <ul className="pb-list pb-disclosures-list">
          {DISCLOSURES_PLANNED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
