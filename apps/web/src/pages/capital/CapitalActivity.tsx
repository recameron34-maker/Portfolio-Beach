import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option, Switch } from '@fluentui/react-components';
import { ChevronLeft16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import type { CapitalNoticePage, CapitalNoticeRow, CapitalNoticeState } from '@pb/contracts';
import { CAPITAL_TABS } from '../../app/nav.js';
import { capitalNoticesQuery, LIST_LIMIT } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, labelOf } from '../../lib/format.js';
import { dueLabel, dueTone, humanizeState, noticeTone } from '../../lib/states.js';
import {
  byDueDate,
  dayCount,
  distinctNames,
  filterNotices,
  isNoticeState,
  isSettled,
  NOTICE_STATES,
  noticeAmount,
  noticeCounts,
  noticeSubject,
  noticeTypes,
} from './notices.js';
import './capital.css';
import { balanceTiles } from '../../lib/tiles.js';

export { CommitmentsPage } from './Commitments.js';
export { CapitalNoticePage } from './NoticeDetail.js';

/** The due date with its alert, which applies only until the money moves (docs/18 section 3). */
function DueCell({
  notice,
  alertDays,
}: {
  notice: CapitalNoticeRow;
  alertDays: number;
}): ReactNode {
  return (
    <td>
      <span className="pb-cap-due">
        <span className="pb-nowrap">{formatDate(notice.dueDate)}</span>
        {isSettled(notice.state) ? null : (
          <Badge tone={dueTone(notice.daysToDue, [alertDays])}>{dueLabel(notice.daysToDue)}</Badge>
        )}
      </span>
    </td>
  );
}

function SubjectLink({ notice }: { notice: CapitalNoticeRow }): ReactNode {
  return (
    <Link to="/capital-activity/$id" params={{ id: notice.id }}>
      {noticeSubject(notice)}
    </Link>
  );
}

function StateBadge({ state }: { state: CapitalNoticeState }): ReactNode {
  return <Badge tone={noticeTone(state)}>{humanizeState(state)}</Badge>;
}

function Tiles({ page }: { page: CapitalNoticePage }): ReactNode {
  const c = noticeCounts(page.items, page.alertDaysBeforeDue);
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="notice-tiles">
      <StatTile
        label="Overdue"
        value={String(c.overdue)}
        hint="Past the due date, not yet funded"
        tone={c.overdue > 0 ? 'bad' : undefined}
      />
      <StatTile
        label="Due soon"
        value={String(c.dueSoon)}
        hint={`Due within ${dayCount(page.alertDaysBeforeDue)}, not yet funded`}
        tone={c.dueSoon > 0 ? 'watch' : undefined}
      />
      <StatTile label="In flight" value={String(c.inFlight)} hint="Not yet reconciled" />
      <StatTile label="Reconciled" value={String(c.reconciled)} hint="Cash flows promoted" />
    </div>
  );
}

function AttentionCard({ page }: { page: CapitalNoticePage }): ReactNode {
  const rows = byDueDate(page.attention);
  return (
    <Card testId="notice-attention">
      <SectionHeader aside={rows.length === 0 ? undefined : `${rows.length} notices`}>
        Needs attention
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing needs attention"
          detail={`No notice is in flight or due within ${dayCount(page.alertDaysBeforeDue)} of ${formatDate(page.asOf)}.`}
        />
      ) : (
        <TableWrap label="Notices needing attention">
          <table className="pb-table" aria-label="Notices needing attention">
            <thead>
              <tr>
                <th>Due</th>
                <th>Type</th>
                <th>Company or fund</th>
                <th className="num">Amount</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <DueCell notice={n} alertDays={page.alertDaysBeforeDue} />
                  <td>{labelOf(n.noticeType)}</td>
                  <td>
                    <span className="pb-cap-subject">
                      <SubjectLink notice={n} />
                      {n.scenarioTag === null ? null : (
                        <Badge plain tone="neutral">
                          {labelOf(n.scenarioTag)}
                        </Badge>
                      )}
                    </span>
                  </td>
                  <NumCell>{noticeAmount(n.amount, n.currency)}</NumCell>
                  <td>
                    <StateBadge state={n.state} />
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

/** Rows per page of the notice register: the full history runs to hundreds of notices. */
const PAGE_SIZE = 25;

function NoticesCard({ page }: { page: CapitalNoticePage }): ReactNode {
  const [state, setStateFilter] = useState<CapitalNoticeState | ''>('');
  const [noticeType, setNoticeTypeFilter] = useState('');
  const [vehicle, setVehicleFilter] = useState('');
  const [includeReconciled, setIncludeReconciledFilter] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  // Any filter change starts again from the first page.
  const refilter =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      set(value);
      setPageIndex(0);
    };
  const setState = refilter(setStateFilter);
  const setNoticeType = refilter(setNoticeTypeFilter);
  const setVehicle = refilter(setVehicleFilter);
  const setIncludeReconciled = refilter(setIncludeReconciledFilter);
  const rows = filterNotices(page.items, { state, noticeType, vehicle, includeReconciled });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(pageIndex, pages - 1);
  const from = current * PAGE_SIZE;
  const shown = rows.slice(from, from + PAGE_SIZE);
  const types = noticeTypes(page.items);
  const vehicles = distinctNames(page.items.map((n) => n.vehicleName));
  return (
    <Card testId="notice-board">
      <SectionHeader aside="Latest due date first">All notices</SectionHeader>
      <Toolbar>
        <Field>
          <Label htmlFor="notice-state">State</Label>
          <Dropdown
            id="notice-state"
            className="pb-cap-filter"
            value={state === '' ? 'All states' : humanizeState(state)}
            selectedOptions={[state]}
            onOptionSelect={(_e, d) => {
              const v = d.optionValue ?? '';
              setState(isNoticeState(v) ? v : '');
            }}
          >
            <Option value="">All states</Option>
            {NOTICE_STATES.map((s) => (
              <Option key={s} value={s}>
                {humanizeState(s)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor="notice-type">Type</Label>
          <Dropdown
            id="notice-type"
            className="pb-cap-filter"
            value={noticeType === '' ? 'All types' : labelOf(noticeType)}
            selectedOptions={[noticeType]}
            onOptionSelect={(_e, d) => setNoticeType(d.optionValue ?? '')}
          >
            <Option value="">All types</Option>
            {types.map((t) => (
              <Option key={t} value={t}>
                {labelOf(t)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field>
          <Label htmlFor="notice-vehicle">Vehicle</Label>
          <Dropdown
            id="notice-vehicle"
            className="pb-cap-filter is-wide"
            value={vehicle === '' ? 'All vehicles' : vehicle}
            selectedOptions={[vehicle]}
            onOptionSelect={(_e, d) => setVehicle(d.optionValue ?? '')}
          >
            <Option value="">All vehicles</Option>
            {vehicles.map((v) => (
              <Option key={v} value={v}>
                {v}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Switch
          label="Include reconciled"
          checked={includeReconciled}
          onChange={(_e, d) => setIncludeReconciled(d.checked)}
        />
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState
          title="No notices match these filters"
          detail="Pick another state, type or vehicle, or include reconciled notices."
        />
      ) : (
        <TableWrap label="Capital notices">
          <table className="pb-table" aria-label="Capital notices">
            <thead>
              <tr>
                <th>Due</th>
                <th>Type</th>
                <th>Company or fund</th>
                <th>Vehicle</th>
                <th>Issued</th>
                <th className="num">Amount</th>
                <th className="num">Settled</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((n) => (
                <tr key={n.id}>
                  <DueCell notice={n} alertDays={page.alertDaysBeforeDue} />
                  <td>{labelOf(n.noticeType)}</td>
                  <td>
                    <SubjectLink notice={n} />
                  </td>
                  <td>{n.vehicleName}</td>
                  <td className="pb-nowrap">{formatDate(n.issueDate)}</td>
                  <NumCell>{noticeAmount(n.amount, n.currency)}</NumCell>
                  <NumCell>{noticeAmount(n.settledAmount, n.currency)}</NumCell>
                  <td>
                    <StateBadge state={n.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Toolbar
        end={
          pages > 1 ? (
            <>
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronLeft16Regular />}
                disabled={current === 0}
                onClick={() => setPageIndex(current - 1)}
              >
                Previous
              </Button>
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronRight16Regular />}
                iconPosition="after"
                disabled={current >= pages - 1}
                onClick={() => setPageIndex(current + 1)}
              >
                Next
              </Button>
            </>
          ) : undefined
        }
      >
        <p className="pb-meta" data-testid="notice-count">
          {pages > 1
            ? `Notices ${from + 1} to ${from + shown.length} of ${rows.length}`
            : rows.length === 1
              ? '1 notice shown'
              : `${rows.length} notices shown`}
          {page.nextCursor === null ? null : `. Showing the first ${LIST_LIMIT}; more exist.`}
        </p>
      </Toolbar>
    </Card>
  );
}

/**
 * The funding tracker (docs/04 M16, docs/18 section 3): calls, distributions and payments with
 * their due-date alerts, what needs attention now, and every notice with client-side filters.
 */
export function CapitalActivityPage(): ReactNode {
  const q = useQuery({ ...capitalNoticesQuery({}), placeholderData: keepPreviousData });
  if (q.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (q.isError) {
    return (
      <>
        <PageHeader title="Capital activity" />
        <TabNav label="Capital activity" items={CAPITAL_TABS} />
        <UnavailableState
          card
          error={q.error}
          subject="Capital notices"
          errorTitle="Capital notices unavailable"
          testId="notices-unavailable"
        />
      </>
    );
  }
  const page = q.data;
  return (
    <>
      <PageHeader
        title="Capital activity"
        meta={`As of ${formatDate(page.asOf)}. Alerts at ${dayCount(page.alertDaysBeforeDue)} before the due date.`}
      />
      <TabNav label="Capital activity" items={CAPITAL_TABS} />
      <Tiles page={page} />
      <AttentionCard page={page} />
      <NoticesCard page={page} />
    </>
  );
}
