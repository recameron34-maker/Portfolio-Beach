import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { CapitalNoticeCommand, CapitalNoticeDetail, CapitalNoticeState } from '@pb/contracts';
import { capitalNoticeMachine } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { describeActionError, useCapitalNoticeCommand } from '../../app/mutations.js';
import { capitalNoticeQuery, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValueTable,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import { formatDate, labelOf } from '../../lib/format.js';
import {
  commandLabel,
  commandOptions,
  dueLabel,
  dueTone,
  humanizeState,
  noticeTone,
} from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import {
  ActionLogCard,
  ActionStatus,
  CommandButtons,
  ReasonDialog,
} from '../../components/WorkflowActions.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  ALERT_DAYS_BEFORE_DUE,
  cashFlowTone,
  isSettled,
  noticeAmount,
  noticeSubject,
  progressSteps,
} from './notices.js';
import './capital.css';

type NoticeOption = CommandOption<CapitalNoticeState, CapitalNoticeCommand>;

const BANK_DETAILS =
  'Bank details are never extracted from documents or shown here (SEC-12.1). The wire register with callback verification arrives with M16, so ticket approval stays blocked in this build (SEC-12.2).';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-cap-back">
      <Link to="/capital-activity">All capital notices</Link>
    </p>
  );
}

function ProgressStrip({ state }: { state: CapitalNoticeState }): ReactNode {
  return (
    <ol className="pb-cap-progress" aria-label="Notice progress">
      {progressSteps(state).map((step, i) => (
        <li
          key={step.state}
          data-status={step.status}
          {...(step.status === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span className="pb-cap-step">
            <span className="pb-cap-step-number" aria-hidden="true">
              {i + 1}
            </span>
            {humanizeState(step.state)}
          </span>
          {step.status === 'done' ? (
            <Badge tone="good">Done</Badge>
          ) : step.status === 'current' ? (
            <Badge tone="brand">Current</Badge>
          ) : (
            <Badge plain>Upcoming</Badge>
          )}
        </li>
      ))}
    </ol>
  );
}

function DueTile({ notice }: { notice: CapitalNoticeDetail }): ReactNode {
  if (isSettled(notice.state)) {
    return (
      <StatTile
        label="Days to due"
        value="Settled"
        hint={`Was due ${formatDate(notice.dueDate)}`}
      />
    );
  }
  const tone = dueTone(notice.daysToDue, ALERT_DAYS_BEFORE_DUE);
  return (
    <StatTile
      label="Days to due"
      value={dueLabel(notice.daysToDue)}
      hint={`Due ${formatDate(notice.dueDate)}`}
      tone={tone === 'bad' || tone === 'watch' ? tone : undefined}
    />
  );
}

function CashFlowsCard({ notice }: { notice: CapitalNoticeDetail }): ReactNode {
  return (
    <Card testId="notice-cash-flows">
      <SectionHeader>Cash flows created</SectionHeader>
      {notice.cashFlows.length === 0 ? (
        <EmptyState
          title="No cash flows yet"
          detail="They are created when the ticket is approved and funding is confirmed."
        />
      ) : (
        <TableWrap label="Cash flows created">
          <table className="pb-table" aria-label="Cash flows created">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {notice.cashFlows.map((f, i) => (
                <tr key={`${f.date}-${f.flowType}-${i}`}>
                  <td className="pb-nowrap">{formatDate(f.date)}</td>
                  <td>{labelOf(f.flowType)}</td>
                  <NumCell>{noticeAmount(f.amount, notice.currency)}</NumCell>
                  <td>
                    <Badge tone={cashFlowTone(f.status)}>{labelOf(f.status)}</Badge>
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

function WorkflowCard({
  notice,
  roles,
  onLog,
}: {
  notice: CapitalNoticeDetail;
  roles: readonly string[];
  onLog: ActionLog;
}): ReactNode {
  const command = useCapitalNoticeCommand();
  const [reasonFor, setReasonFor] = useState<NoticeOption | null>(null);
  const options = commandOptions(capitalNoticeMachine, notice.state, roles);
  const subject = noticeSubject(notice);
  const issue = (option: NoticeOption, reason?: string): void => {
    command.mutate(
      {
        id: notice.id,
        body:
          reason === undefined ? { command: option.command } : { command: option.command, reason },
      },
      {
        onSuccess: (updated) =>
          onLog.record(
            'good',
            `${labelOf(updated.noticeType)} for ${noticeSubject(updated)} is now ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) =>
          onLog.record('bad', `${commandLabel(option.command)}: ${describeActionError(error)}`),
      },
    );
  };
  const notes = options.filter((o) => o.note !== undefined);
  return (
    <Card testId="notice-workflow">
      <SectionHeader aside={previewMode ? <SimulatedBadge /> : undefined}>Workflow</SectionHeader>
      <ActionStatus latest={onLog.latest} testId="notice-action-status" />
      {options.length === 0 ? (
        <p className="pb-meta">
          {humanizeState(notice.state)} is the last step; nothing further to do.
        </p>
      ) : (
        <div className="pb-cap-actions">
          <CommandButtons
            options={options}
            busy={command.isPending}
            appearance="secondary"
            notAllowedTitle={(o) => (o.command === 'extract' ? 'Service accounts only' : undefined)}
            onIssue={(o) => (o.needsReason ? setReasonFor(o) : issue(o))}
          />
        </div>
      )}
      {notes.length > 0 ? (
        <ul className="pb-list pb-cap-notes">
          {notes.map((o) => (
            <li key={o.command} className="pb-meta">
              {commandLabel(o.command)}: {o.note}
            </li>
          ))}
        </ul>
      ) : null}
      {previewMode || options.length === 0 ? null : (
        <p className="pb-meta">
          Workflow actions arrive with Phase 3. This build reads only, so every action is shown but
          disabled.
        </p>
      )}
      <p className="pb-meta" data-testid="bank-details-note">
        {BANK_DETAILS}
      </p>
      {reasonFor !== null ? (
        <ReasonDialog
          title={commandLabel(reasonFor.command)}
          subject={`${labelOf(notice.noticeType)} for ${subject}`}
          onCancel={() => setReasonFor(null)}
          onSubmit={(reason) => {
            issue(reasonFor, reason);
            setReasonFor(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function NoticeBody({
  notice,
  roles,
}: {
  notice: CapitalNoticeDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  const subject = noticeSubject(notice);
  const splits = Object.entries(notice.split);
  const hold = notice.wireChangeHold;
  return (
    <>
      <BackLink />
      <PageHeader
        testId="notice-banner"
        title={`${labelOf(notice.noticeType)}: ${subject}`}
        meta={
          <span className="pb-meta-list">
            <span>{notice.vehicleName}</span>
            <span>Issued {formatDate(notice.issueDate)}</span>
            <span>Due {formatDate(notice.dueDate)}</span>
            <span>
              {noticeAmount(notice.amount, notice.currency)} {notice.currency}
            </span>
          </span>
        }
        actions={<Badge tone={noticeTone(notice.state)}>{humanizeState(notice.state)}</Badge>}
      />
      <ProgressStrip state={notice.state} />
      {hold === null ? null : (
        <p className="pb-notice pb-notice-bad pb-cap-hold" data-testid="wire-hold">
          Wire instructions changed within the hold window. Ticket approval is held until{' '}
          {formatDate(hold.until)} ({hold.holdDays} days, SEC-12.3).
        </p>
      )}
      <div className="pb-tiles" data-testid="notice-tiles">
        <StatTile label="Amount" value={noticeAmount(notice.amount, notice.currency)} />
        <StatTile
          label="Settled"
          value={noticeAmount(notice.settledAmount, notice.currency)}
          hint={
            notice.settledAmount === null
              ? 'No approved cash flow yet'
              : 'Sum of approved cash flows'
          }
        />
        <DueTile notice={notice} />
        <StatTile label="Currency" value={notice.currency} />
      </div>
      <div className="pb-two-col">
        <WorkflowCard notice={notice} roles={roles} onLog={log} />
        <Card testId="notice-notes">
          <SectionHeader>Notes</SectionHeader>
          {notice.notes.length === 0 ? (
            <EmptyState title="No notes" />
          ) : (
            <ul className="pb-list">
              {notice.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="pb-two-col">
        <Card testId="notice-split">
          <SectionHeader>Split</SectionHeader>
          {splits.length === 0 ? (
            <EmptyState
              title="No split recorded"
              detail="The notice does not break the amount into investment, fees, expenses or interest."
            />
          ) : (
            <KeyValueTable
              label="Split"
              columns={1}
              rows={splits.map(([key, value]) => ({
                label: labelOf(key),
                value: noticeAmount(value, notice.currency),
              }))}
            />
          )}
        </Card>
        <CashFlowsCard notice={notice} />
      </div>
      <ActionLogCard entries={log.entries} />
    </>
  );
}

/** One capital notice through the funding workflow (docs/18 section 3), with its split and cash flows. */
export function CapitalNoticePage(): ReactNode {
  const { id } = useParams({ from: '/app/capital-activity/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(capitalNoticeQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <>
        <BackLink />
        {hidden ? (
          <ErrorState
            title="Notice not found or not visible to you"
            detail="There is no capital notice with this id in your view of the portfolio."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This capital notice"
            errorTitle="Capital notice unavailable"
            testId="notice-unavailable"
          />
        )}
      </>
    );
  }
  return <NoticeBody notice={q.data} roles={me.data?.roles ?? []} />;
}
