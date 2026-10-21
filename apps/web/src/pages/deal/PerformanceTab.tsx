import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Input, Label, Option, Spinner } from '@fluentui/react-components';
import type {
  InvestmentPerformance,
  QuarterRow,
  RealizationOutlookCode,
  RealizationOutlookDetail,
} from '@pb/contracts';
import { describeActionError, useSetRealizationOutlook } from '../../app/mutations.js';
import { investmentPerformanceQuery, meQuery, realizationOutlookQuery } from '../../app/queries.js';
import { LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  KeyValueTable,
  NumCell,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import { ActionStatus } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  formatMonthYear,
  formatMonthYearShort,
  formatMultiple,
  formatPct,
  labelOf,
  MISSING,
  moneyLabel,
  plural,
} from '../../lib/format.js';
import { creditStatusTone } from '../../lib/labels.js';
import { isReason, resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  approvedQuarters,
  canSetOutlook,
  documentHref,
  HIGHLIGHT_QUARTERS,
  HORIZON_MONTHS,
  isApproved,
  isHorizon,
  isOutlookCode,
  newestFirst,
  oldestFirst,
  OUTLOOK_CODES,
  outlookLabel,
  quarterRowsNewestFirst,
  runHref,
  sinceEntryGap,
  sourceLabel,
  toNumber,
  useDealDetail,
  useDealId,
} from './data.js';
import { HubLink, PeriodCell, RecordStatusBadge } from './parts.js';
import './deal.css';
import { balanceTiles } from '../../lib/tiles.js';

type CreditBlock = NonNullable<InvestmentPerformance['credit']>;

/* ---- Equity and CV positions ---- */

function SinceEntryCard({ perf }: { perf: InvestmentPerformance }): ReactNode {
  const s = perf.sinceEntry;
  const gap = sinceEntryGap(perf);
  if (s === null) {
    const entryDate = perf.entry?.periodEnd ?? null;
    return (
      <Card testId="deal-since-entry">
        <SectionHeader>Since entry</SectionHeader>
        {gap === 'forward_entry' && entryDate !== null ? (
          <EmptyState
            title="The entry snapshot is dated after the as-of date"
            detail={`The snapshot is dated ${formatDate(entryDate)}, after ${formatDate(perf.asOf)}, so nothing is compared against it yet.`}
          />
        ) : gap === 'no_quarter' ? (
          <EmptyState
            title="No approved quarter to compare with the entry snapshot"
            detail={`Growth since entry needs an approved quarter on or before ${formatDate(perf.asOf)}.`}
          />
        ) : (
          <EmptyState
            title="No entry snapshot recorded"
            detail="Growth since entry is measured against the financials pinned at the investment date; none are on record for this position."
          />
        )}
      </Card>
    );
  }
  const latest = perf.quarters.find((q) => q.periodEnd === s.periodEnd) ?? null;
  const entryDate = perf.entry?.periodEnd ?? null;
  return (
    <Card testId="deal-since-entry">
      <SectionHeader
        aside={
          entryDate === null
            ? `To ${formatDate(s.periodEnd)}`
            : `Entry snapshot ${formatDate(entryDate)} to ${formatDate(s.periodEnd)}`
        }
      >
        Since entry
      </SectionHeader>
      <div ref={balanceTiles} className="pb-tiles pb-deal-tiles pb-deal-aligned">
        <StatTile
          label="Revenue growth"
          value={formatPct(s.revenueGrowth)}
          hint="LTM revenue against entry"
        />
        <StatTile
          label="EBITDA growth"
          value={formatPct(s.ebitdaGrowth)}
          hint="LTM EBITDA against entry"
        />
        <StatTile
          label="Multiple change"
          value={formatMultiple(s.multipleDelta)}
          hint={`EV / EBITDA ${formatMultiple(s.evToEbitdaAtEntry)} at entry`}
        />
        <StatTile
          label="EV / EBITDA at entry"
          value={formatMultiple(s.evToEbitdaAtEntry)}
          hint={`Latest ${formatMultiple(latest?.evToEbitda ?? null)}`}
        />
        <StatTile
          label="Net debt / EBITDA at entry"
          value={formatMultiple(s.netDebtToEbitdaAtEntry)}
          hint={`Latest ${formatMultiple(latest?.netDebtToEbitda ?? null)}`}
        />
      </div>
    </Card>
  );
}

function LtmChart({ perf, company }: { perf: InvestmentPerformance; company: string }): ReactNode {
  const quarters = approvedQuarters(perf);
  const first = quarters[0];
  const last = quarters[quarters.length - 1];
  if (first === undefined || last === undefined) {
    return (
      <EmptyState
        title="No approved quarters to chart"
        detail="Revenue and EBITDA are charted from approved quarters only."
      />
    );
  }
  return (
    <LineChart
      title="Revenue and EBITDA, LTM"
      subtitle="Approved quarters"
      x={quarters.map((q) => formatMonthYearShort(q.periodEnd))}
      series={[
        { name: 'Revenue', values: quarters.map((q) => toNumber(q.revenueLtm)) },
        { name: 'EBITDA', values: quarters.map((q) => toNumber(q.ebitdaLtm)) },
      ]}
      kind="money"
      format={moneyLabel}
      summary={`LTM revenue and EBITDA for ${company} over ${quarters.length} approved quarters: revenue from ${formatMoneyM(first.revenueLtm)} to ${formatMoneyM(last.revenueLtm)} and EBITDA from ${formatMoneyM(first.ebitdaLtm)} to ${formatMoneyM(last.ebitdaLtm)}, ${formatMonthYear(first.periodEnd)} to ${formatMonthYear(last.periodEnd)}.`}
      testId="deal-ltm-chart"
    />
  );
}

/**
 * Click-to-source (docs/11 I1): the quarter's figures link to the page of the document they were
 * read from, and to the extraction run that read them when one did. A quarter with no source
 * document shows the missing placeholder, never a guessed page.
 */
function SourceCell({ q }: { q: QuarterRow }): ReactNode {
  const testId = `performance-source-${q.periodEnd}`;
  if (q.source === null)
    return (
      <td className="is-missing">
        <span data-testid={testId}>{MISSING}</span>
      </td>
    );
  return (
    <td>
      <span className="pb-deal-source">
        <HubLink href={documentHref(q.source.documentId)} testId={testId}>
          {sourceLabel(q.source)}
          <span className="pb-visually-hidden">{`, source of ${formatDate(q.periodEnd)}`}</span>
        </HubLink>
        {q.source.runId === null ? null : (
          <HubLink href={runHref(q.source.runId)} className="pb-meta">
            {/* The space sits outside the hidden span: a leading space inside it is dropped from the name. */}
            run <span className="pb-visually-hidden">{`that read ${formatDate(q.periodEnd)}`}</span>
          </HubLink>
        )}
      </span>
    </td>
  );
}

function QuarterlyCard({
  perf,
  company,
}: {
  perf: InvestmentPerformance;
  company: string;
}): ReactNode {
  const rows = quarterRowsNewestFirst(perf);
  return (
    <Card testId="deal-quarterly">
      <SectionHeader aside={`LTM figures, newest first, as of ${formatDate(perf.asOf)}`}>
        Quarterly financials
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No quarterly financials"
          detail="Quarterly financials appear here once they are extracted and approved."
        />
      ) : (
        <>
          <LtmChart perf={perf} company={company} />
          <TableWrap label="Quarterly financials">
            <table
              className="pb-table pb-deal-dense"
              aria-label="Quarterly financials"
              data-testid="performance-sources"
            >
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="num">Revenue</th>
                  <th className="num">EBITDA</th>
                  <th className="num">Margin</th>
                  <th className="num">EV</th>
                  <th className="num">Net debt</th>
                  <th className="num">Cash</th>
                  <th className="num">Equity</th>
                  <th className="num">EV / EBITDA</th>
                  <th className="num">Net debt / EBITDA</th>
                  <th className="num">Revenue YoY</th>
                  <th className="num">EBITDA YoY</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={`${q.periodEnd}-${q.isEntrySnapshot ? 'entry' : 'quarter'}`}>
                    <td>
                      <PeriodCell periodEnd={q.periodEnd} entry={q.isEntrySnapshot} />
                    </td>
                    <td>
                      <RecordStatusBadge status={q.status} />
                    </td>
                    <NumCell>{formatMoneyM(q.revenueLtm)}</NumCell>
                    <NumCell>{formatMoneyM(q.ebitdaLtm)}</NumCell>
                    <NumCell>{formatPct(q.ebitdaMargin)}</NumCell>
                    <NumCell>{formatMoneyM(q.ev)}</NumCell>
                    <NumCell>{formatMoneyM(q.netDebt)}</NumCell>
                    <NumCell>{formatMoneyM(q.cash)}</NumCell>
                    <NumCell>{formatMoneyM(q.totalEquity)}</NumCell>
                    <NumCell>{formatMultiple(q.evToEbitda)}</NumCell>
                    <NumCell>{formatMultiple(q.netDebtToEbitda)}</NumCell>
                    <NumCell>{formatPct(q.revenueYoy)}</NumCell>
                    <NumCell>{formatPct(q.ebitdaYoy)}</NumCell>
                    <SourceCell q={q} />
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="pb-meta pb-deal-note">
            Year on year compares with the same fiscal quarter one year earlier only; when that
            quarter is missing the change is not calculated ({MISSING}). Source is the document page
            the quarter's figures were read from; a quarter with no source document shows {MISSING}.
          </p>
        </>
      )}
    </Card>
  );
}

function HighlightsCard({ perf }: { perf: InvestmentPerformance }): ReactNode {
  const latest = newestFirst(perf.quarters).slice(0, HIGHLIGHT_QUARTERS);
  const recorded = latest.some((q) => q.highlights.length > 0);
  return (
    <Card testId="deal-highlights">
      <SectionHeader
        aside={latest.length > 0 ? `Latest ${plural(latest.length, 'quarter')}` : undefined}
      >
        Highlights
      </SectionHeader>
      {!recorded ? (
        <EmptyState
          title="No highlights recorded"
          detail="Business highlights from the quarterly reports appear here with each quarter."
        />
      ) : (
        <div className="pb-deal-highlights">
          {latest.map((q) => (
            <div key={q.periodEnd}>
              <h3>
                {formatDate(q.periodEnd)}
                {isApproved(q.status) ? null : <RecordStatusBadge status={q.status} />}
              </h3>
              {q.highlights.length === 0 ? (
                <p className="pb-meta">None recorded for this quarter.</p>
              ) : (
                <ul className="pb-list">
                  {q.highlights.map((h, i) => (
                    <li key={`${i}-${h}`}>{h}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---- Realization outlook (docs/04 M9): read by everyone, set by the deal team ---- */

const OUTLOOK_READ_ONLY = 'The deal team sets the outlook; your role reads it.';

/**
 * The edit form: outlook, horizon in months, an optional note and the reason the audit event
 * keeps. Every write goes through PUT /monitoring/outlook, which the API refuses unless the config
 * guard allows a hand edit; nothing automated ever sets the outlook. The form starts from the
 * recorded outlook and keeps what the user typed; the table above always shows what is on record.
 */
function OutlookForm({
  detail,
  investmentId,
  log,
}: {
  detail: RealizationOutlookDetail;
  investmentId: string;
  log: ActionLog;
}): ReactNode {
  const ids = { outlook: useId(), horizon: useId(), note: useId(), reason: useId() };
  const set = useSetRealizationOutlook();
  const [outlook, setOutlook] = useState<RealizationOutlookCode>(detail.outlook);
  const [horizon, setHorizon] = useState(String(detail.horizonMonths));
  const [note, setNote] = useState(detail.note ?? '');
  const [reason, setReason] = useState('');
  const valid = isHorizon(horizon) && isReason(reason);
  const busy = set.isPending;
  return (
    <>
      <form
        className="pb-deal-outlook-form"
        data-testid="outlook-form"
        aria-label="Set the realization outlook"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy) return;
          const trimmedNote = note.trim();
          set.mutate(
            {
              investmentId,
              body: {
                outlook,
                horizonMonths: Number(horizon.trim()),
                note: trimmedNote === '' ? null : trimmedNote,
                reason: reason.trim(),
              },
            },
            {
              onSuccess: (after) => {
                setReason('');
                log.record(
                  'good',
                  `Outlook set to ${outlookLabel(after.outlook)} ${resultSuffix()}`,
                );
              },
              onError: (error) => log.record('bad', `Set outlook: ${describeActionError(error)}`),
            },
          );
        }}
      >
        <Field>
          <Label htmlFor={ids.outlook}>Outlook</Label>
          <Dropdown
            id={ids.outlook}
            className="pb-deal-outlook-control"
            value={outlookLabel(outlook)}
            selectedOptions={[outlook]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              if (isOutlookCode(v)) setOutlook(v);
            }}
          >
            {OUTLOOK_CODES.map((code) => (
              <Option key={code} value={code}>
                {outlookLabel(code)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor={ids.horizon}>Horizon (months)</Label>
          <Input
            id={ids.horizon}
            className="pb-deal-outlook-control is-short"
            type="number"
            min={HORIZON_MONTHS.min}
            max={HORIZON_MONTHS.max}
            value={horizon}
            onChange={(_e, d) => setHorizon(d.value)}
          />
        </Field>
        <Field>
          <Label htmlFor={ids.note}>Note</Label>
          <Input
            id={ids.note}
            className="pb-deal-outlook-control is-wide"
            value={note}
            maxLength={500}
            placeholder="Optional"
            onChange={(_e, d) => setNote(d.value)}
          />
        </Field>
        <Field>
          <Label htmlFor={ids.reason}>Reason</Label>
          <Input
            id={ids.reason}
            className="pb-deal-outlook-control is-wide"
            value={reason}
            maxLength={500}
            placeholder="Required, kept on the audit trail"
            onChange={(_e, d) => setReason(d.value)}
          />
        </Field>
        {/* Stays focusable while it cannot act, so keyboard focus is not lost mid-edit. */}
        <Button
          type="submit"
          size="small"
          appearance="primary"
          disabledFocusable={!valid || busy}
          {...(valid
            ? {}
            : {
                title: `Needs a horizon of ${HORIZON_MONTHS.min} to ${HORIZON_MONTHS.max} months and a reason of at least three characters`,
              })}
        >
          Set outlook
        </Button>
      </form>
    </>
  );
}

/**
 * The realization outlook of the position: what the deal team expects (none, a partial or a full
 * realization) and within how many months, read from the monitoring API, with the edit form for
 * the deal team. Everyone else reads it. Changes only by explicit edit, audited (SEC-11.1).
 */
function OutlookCard({ id }: { id: string }): ReactNode {
  const me = useQuery(meQuery);
  const q = useQuery(realizationOutlookQuery(id));
  // The page's one status region lives with the card, so an edit's result outlives the form.
  const log = useActionLog();
  const roles = me.data?.roles ?? [];
  let body: ReactNode;
  // Nothing is said about the role until it is known: a deal team member must never read "your
  // role reads it" for the moment the identity is in flight.
  if (q.isPending || me.isPending) {
    body = <Spinner size="tiny" label="Loading the realization outlook" />;
  } else if (q.isLoadingError) {
    body = (
      <UnavailableState
        inline
        error={q.error}
        subject="The realization outlook"
        notReady={{ title: 'The realization outlook is not available in this build' }}
        testId="outlook-unavailable"
      />
    );
  } else {
    const o = q.data;
    body = (
      <>
        <KeyValueTable
          label="Realization outlook"
          columns={1}
          rows={[
            {
              label: 'Outlook',
              value: (
                <Badge tone={o.outlook === 'none' ? 'neutral' : 'brand'}>
                  {outlookLabel(o.outlook)}
                </Badge>
              ),
            },
            { label: 'Horizon', value: `Within ${plural(o.horizonMonths, 'month')}` },
            { label: 'Note', value: o.note ?? MISSING },
            { label: 'Set by', value: o.setBy ?? MISSING },
            { label: 'Set', value: o.setAt === null ? MISSING : formatDateTime(o.setAt) },
          ]}
        />
        {canSetOutlook(roles) ? (
          <>
            <OutlookForm detail={o} investmentId={id} log={log} />
            <ActionStatus latest={log.latest} testId="outlook-action-status" />
          </>
        ) : (
          <p className="pb-meta pb-deal-note" data-testid="outlook-read-only">
            {OUTLOOK_READ_ONLY}
          </p>
        )}
      </>
    );
  }
  return (
    <Card testId="outlook-card">
      <SectionHeader aside={<SimulatedBadge />}>Realization outlook</SectionHeader>
      {body}
      <p className="pb-meta pb-deal-note">
        Changes only by explicit edit, with a reason on the audit trail (docs/04 M9); nothing
        automated sets it.
      </p>
    </Card>
  );
}

function EquityPerformance({
  perf,
  company,
}: {
  perf: InvestmentPerformance;
  company: string;
}): ReactNode {
  return (
    <>
      <SinceEntryCard perf={perf} />
      <QuarterlyCard perf={perf} company={company} />
      <div className="pb-two-col">
        <HighlightsCard perf={perf} />
        <OutlookCard id={perf.investmentId} />
      </div>
    </>
  );
}

/* ---- Private credit positions (docs/04 M9, docs/08 section 10) ---- */

/** The facility terms in two single-column tables: side by side on a laptop, stacked on a phone. */
function CreditTermsCard({ credit }: { credit: CreditBlock }): ReactNode {
  const t = credit.terms;
  return (
    <Card testId="deal-credit-terms">
      <SectionHeader aside={`Effective ${formatDate(t.effectiveDate)}`}>Credit terms</SectionHeader>
      {/* Each table in its own cell: adjacent table wrappers would pick up the stacked-table margin. */}
      <div className="pb-deal-split">
        <div>
          <KeyValueTable
            label="Facility and pricing"
            columns={1}
            rows={[
              { label: 'Facility', value: labelOf(t.facilityType) },
              { label: 'Seniority', value: `Rank ${t.seniorityRank}` },
              { label: 'Commitment', value: formatMoneyM(t.commitmentAmount) },
              { label: 'Base rate', value: labelOf(t.baseRate) },
              { label: 'Floor', value: formatPct(t.floor, 2) },
              { label: 'Spread', value: formatPct(t.spread, 2) },
              {
                label: 'Cash / PIK coupon',
                value: `${formatPct(t.cashCoupon, 2)} / ${formatPct(t.pikCoupon, 2)}`,
              },
            ]}
          />
        </div>
        <div>
          <KeyValueTable
            label="Fees, yield and maturity"
            columns={1}
            rows={[
              { label: 'OID', value: formatPct(t.oid, 2) },
              { label: 'Upfront fee', value: formatPct(t.upfrontFee, 2) },
              { label: 'All-in coupon', value: formatPct(t.allInCoupon, 2) },
              { label: 'Yield to maturity', value: formatPct(t.yieldToMaturity, 2) },
              {
                label: 'Maturity',
                value: (
                  <span className="pb-deal-period">
                    <span className="pb-nowrap">{formatDate(t.maturityDate)}</span>
                    {t.pastMaturity ? <Badge tone="bad">Past maturity</Badge> : null}
                  </span>
                ),
              },
              { label: 'Payment frequency', value: labelOf(t.paymentFrequency) },
              { label: 'Effective date', value: formatDate(t.effectiveDate) },
            ]}
          />
        </div>
      </div>
    </Card>
  );
}

function CreditChart({ credit, company }: { credit: CreditBlock; company: string }): ReactNode {
  const quarters = oldestFirst(credit.quarters);
  const last = quarters[quarters.length - 1];
  if (last === undefined) return null;
  return (
    <LineChart
      title="Par and fair value"
      subtitle="By quarter"
      x={quarters.map((q) => formatMonthYearShort(q.periodEnd))}
      series={[
        { name: 'Par', values: quarters.map((q) => toNumber(q.parValue)) },
        { name: 'Fair value', values: quarters.map((q) => toNumber(q.fairValue)) },
      ]}
      kind="money"
      format={moneyLabel}
      summary={`Par and fair value for ${company} over ${plural(quarters.length, 'quarter')}; at ${formatMonthYear(last.periodEnd)} fair value is ${formatMoneyM(last.fairValue)} against par of ${formatMoneyM(last.parValue)}.`}
      testId="deal-credit-chart"
    />
  );
}

function CreditQuartersCard({
  credit,
  company,
}: {
  credit: CreditBlock;
  company: string;
}): ReactNode {
  const rows = newestFirst(credit.quarters);
  return (
    <Card testId="deal-credit-quarters">
      <SectionHeader aside="LTM flows, newest first">Quarterly credit metrics</SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No quarterly credit metrics"
          detail="Par, fair value, yield, coverage and leverage appear once a quarter is recorded."
        />
      ) : (
        <>
          <CreditChart credit={credit} company={company} />
          <TableWrap label="Quarterly credit metrics">
            <table className="pb-table pb-deal-dense" aria-label="Quarterly credit metrics">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Par</th>
                  <th className="num">Cost</th>
                  <th className="num">Fair value</th>
                  <th className="num">Accrued</th>
                  <th className="num">Cash interest LTM</th>
                  <th className="num">PIK LTM</th>
                  <th className="num">Principal repaid LTM</th>
                  <th className="num">Funded</th>
                  <th className="num">Current yield</th>
                  <th className="num">Coverage</th>
                  <th className="num">Leverage</th>
                  <th className="num">LTV</th>
                  <th>Covenant / payment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.periodEnd}>
                    <td className="pb-nowrap">{formatDate(q.periodEnd)}</td>
                    <NumCell>{formatMoneyM(q.parValue)}</NumCell>
                    <NumCell>{formatMoneyM(q.costBasis)}</NumCell>
                    <NumCell>{formatMoneyM(q.fairValue)}</NumCell>
                    <NumCell>{formatMoneyM(q.accruedInterest)}</NumCell>
                    <NumCell>{formatMoneyM(q.cashInterestLtm)}</NumCell>
                    <NumCell>{formatMoneyM(q.pikCapitalizedLtm)}</NumCell>
                    <NumCell>{formatMoneyM(q.principalRepaidLtm)}</NumCell>
                    <NumCell>{formatMoneyM(q.fundedAmount)}</NumCell>
                    <NumCell>{formatPct(q.currentYield, 2)}</NumCell>
                    <NumCell>{formatMultiple(q.interestCoverage)}</NumCell>
                    <NumCell>{formatMultiple(q.leverageThroughTranche)}</NumCell>
                    <NumCell>{formatPct(q.loanToValue)}</NumCell>
                    <td>
                      <span className="pb-deal-stack">
                        <span title="Covenant status">
                          <Badge tone={creditStatusTone(q.covenantStatus)}>
                            <span className="pb-visually-hidden">Covenant</span>{' '}
                            {labelOf(q.covenantStatus)}
                          </Badge>
                        </span>
                        <span title="Payment status">
                          <Badge tone={creditStatusTone(q.paymentStatus)}>
                            <span className="pb-visually-hidden">Payment</span>{' '}
                            {labelOf(q.paymentStatus)}
                          </Badge>
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="pb-meta pb-deal-note">
            Coverage is EBITDA over cash interest, leverage is net debt through the tranche over
            EBITDA, and LTV is net debt through the tranche over enterprise value (docs/08 section
            10). PIK counts as income only once capitalized into par.
          </p>
        </>
      )}
    </Card>
  );
}

function AmortizationCard({ credit }: { credit: CreditBlock }): ReactNode {
  const schedule = credit.terms.amortization;
  return (
    <Card testId="deal-amortization">
      <SectionHeader>Amortization schedule</SectionHeader>
      {schedule.length === 0 ? (
        <EmptyState
          title="No scheduled amortization"
          detail="No principal repayments are scheduled before maturity."
        />
      ) : (
        <TableWrap label="Amortization schedule">
          <table className="pb-table" aria-label="Amortization schedule">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((a, i) => (
                <tr key={`${a.date}-${i}`}>
                  <td>{formatDate(a.date)}</td>
                  <NumCell>{formatMoneyM(a.amount)}</NumCell>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function CallProtectionCard({ credit, asOf }: { credit: CreditBlock; asOf: string }): ReactNode {
  const steps = credit.terms.callProtection;
  return (
    <Card testId="deal-call-protection">
      <SectionHeader>Call protection</SectionHeader>
      {steps.length === 0 ? (
        <EmptyState
          title="No call protection on record"
          detail="The borrower may repay early without a premium."
        />
      ) : (
        <TableWrap label="Call protection">
          <table className="pb-table" aria-label="Call protection">
            <thead>
              <tr>
                <th>Until</th>
                <th className="num">Premium</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((c, i) => (
                <tr key={`${c.until}-${i}`}>
                  <td>{formatDate(c.until)}</td>
                  <NumCell>{formatPct(c.premium, 2)}</NumCell>
                  <td>
                    {c.until < asOf ? (
                      <Badge tone="neutral">Expired</Badge>
                    ) : (
                      <Badge tone="brand">In force</Badge>
                    )}
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

function CovenantsCard({ credit }: { credit: CreditBlock }): ReactNode {
  const covenants = credit.terms.covenants;
  return (
    <Card testId="deal-covenants">
      <SectionHeader>Covenants</SectionHeader>
      {covenants.length === 0 ? (
        <EmptyState
          title="No covenants on record"
          detail="Financial covenants and how often they are tested appear here."
        />
      ) : (
        <TableWrap label="Covenants">
          <table className="pb-table" aria-label="Covenants">
            <thead>
              <tr>
                <th>Covenant</th>
                <th className="num">Level</th>
                <th>Test</th>
              </tr>
            </thead>
            <tbody>
              {covenants.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <NumCell>{formatMultiple(c.level)}</NumCell>
                  <td>{labelOf(c.test)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function CreditPerformance({
  perf,
  credit,
  company,
}: {
  perf: InvestmentPerformance;
  credit: CreditBlock;
  company: string;
}): ReactNode {
  return (
    <>
      <CreditTermsCard credit={credit} />
      <CreditQuartersCard credit={credit} company={company} />
      <div className="pb-two-col">
        <AmortizationCard credit={credit} />
        <CallProtectionCard credit={credit} asOf={perf.asOf} />
      </div>
      <div className="pb-two-col">
        <CovenantsCard credit={credit} />
        <OutlookCard id={perf.investmentId} />
      </div>
    </>
  );
}

/**
 * Performance tab (docs/04 M9, docs/08 section 4): growth since entry, the approved quarterly
 * series with the source of each quarter, and highlights for equity and CV positions; terms,
 * quarterly credit metrics and schedules for private credit; the realization outlook, with its
 * edit for the deal team, for every position.
 */
export function PerformanceTab(): ReactNode {
  const id = useDealId();
  const detail = useDealDetail();
  const q = useQuery(investmentPerformanceQuery(id));
  if (q.isPending) return <PageSkeleton tiles={5} rows={6} />;
  if (q.isLoadingError) {
    return (
      <UnavailableState
        card
        error={q.error}
        subject="Performance history"
        notReady={{
          title: 'Performance history is not available for this position in this build',
          detail: 'The Overview tab still shows the latest approved quarter from the one-pager.',
        }}
        errorTitle="Performance history could not load"
        testId="deal-performance-unavailable"
      />
    );
  }
  const perf = q.data;
  const company = detail.data?.companyName ?? 'this position';
  return perf.credit !== null ? (
    <CreditPerformance perf={perf} credit={perf.credit} company={company} />
  ) : (
    <EquityPerformance perf={perf} company={company} />
  );
}
