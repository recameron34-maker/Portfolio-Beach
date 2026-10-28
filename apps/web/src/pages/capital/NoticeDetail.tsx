import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type {
  CapitalNoticeAlert,
  CapitalNoticeCommand,
  CapitalNoticeCommandBody,
  CapitalNoticeDetail,
  CapitalNoticeState,
  TradeTicketRow,
  WireInstructionRow,
} from '@pb/contracts';
import { capitalNoticeMachine } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { describeActionError, useCapitalNoticeCommand } from '../../app/mutations.js';
import type { CommandBody } from '../../app/mutations.js';
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
import { formatDate, formatDateTime, labelOf, MISSING } from '../../lib/format.js';
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
import { DraftTicketDialog } from './DraftTicketDialog.js';
import {
  ALERT_DAYS_BEFORE_DUE,
  cashFlowTone,
  isSettled,
  noticeAmount,
  noticeSubject,
  progressSteps,
} from './notices.js';
import { ALERT_WORDS, BLOCKER_WORDS, nothingToRelease, RELEASE_ALLOWED } from './tickets.js';
import { ticketTone, wireTone } from '../../lib/states.js';
import { kindLabel, NUMBER_SOURCE_WORDS, RESULT_WORDS } from './wires.js';
import './capital.css';
import { balanceTiles } from '../../lib/tiles.js';

type NoticeOption = CommandOption<CapitalNoticeState, CapitalNoticeCommand>;

const BANK_DETAILS =
  'Bank details are never extracted from documents (SEC-12.1); tickets release only against a Verified instruction (SEC-12.2, SEC-12.3).';

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

/** The SEC-12.4 alerts: one badge and one plain sentence each, or the word that none stands. */
function AlertsStrip({ alerts }: { alerts: readonly CapitalNoticeAlert[] }): ReactNode {
  return (
    <div className="pb-cap-alerts" data-testid="notice-alerts">
      {alerts.length === 0 ? (
        <p className="pb-meta">No alerts on this notice.</p>
      ) : (
        <ul className="pb-cap-alert-list" aria-label="Notice alerts">
          {alerts.map((alert) => (
            <li key={alert}>
              <Badge tone={ALERT_WORDS[alert].tone}>{ALERT_WORDS[alert].label}</Badge>
              <span>{ALERT_WORDS[alert].sentence}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

/** Whether the ticket can be released now, or every reason it cannot, in words (SEC-12.3). */
function ReleaseStatus({ ticket }: { ticket: TradeTicketRow }): ReactNode {
  if (nothingToRelease(ticket.state)) {
    return (
      <p className="pb-meta pb-cap-release" data-testid="ticket-release">
        Nothing to release: the ticket is {humanizeState(ticket.state)}.
      </p>
    );
  }
  if (ticket.release.allowed) {
    return (
      <p className="pb-notice pb-notice-good pb-cap-release" data-testid="ticket-release">
        {RELEASE_ALLOWED}
      </p>
    );
  }
  return (
    <div className="pb-notice pb-notice-bad pb-cap-release" data-testid="ticket-release">
      <span>Release is blocked:</span>
      <ul aria-label="Release blockers">
        {ticket.release.blockers.map((b) => (
          <li key={b}>{BLOCKER_WORDS[b]}</li>
        ))}
      </ul>
    </div>
  );
}

function personAt(person: { name: string } | null, at: string | null): string {
  if (person === null || at === null) return MISSING;
  return `${person.name}, ${formatDateTime(at)}`;
}

/** The notice's trade ticket (docs/04 M16): the figures, the people and the release check. */
function TicketCard({ notice }: { notice: CapitalNoticeDetail }): ReactNode {
  const ticket = notice.ticket;
  const instruction = ticket?.wireInstruction ?? null;
  return (
    <Card testId="ticket-panel">
      <SectionHeader
        aside={
          ticket === null ? undefined : (
            <Badge tone={ticketTone(ticket.state)}>{humanizeState(ticket.state)}</Badge>
          )
        }
      >
        Trade ticket
      </SectionHeader>
      {ticket === null ? (
        <EmptyState
          title="No trade ticket yet"
          detail="Draft ticket creates one from the notice's amount and due date. The preparer and the approver must differ (SEC-12.3)."
        />
      ) : (
        <>
          <KeyValueTable
            label="Trade ticket"
            rows={[
              { label: 'Amount', value: noticeAmount(ticket.amount, ticket.currency) },
              { label: 'Funding date', value: formatDate(ticket.fundingDate) },
              { label: 'Prepared by', value: personAt(ticket.preparedBy, ticket.preparedAt) },
              { label: 'Approved by', value: personAt(ticket.approvedBy, ticket.approvedAt) },
              {
                label: 'Instruction version',
                value:
                  instruction === null ? (
                    MISSING
                  ) : (
                    <span className="pb-cap-subject">
                      <Link to="/capital-activity/wires/$id" params={{ id: instruction.id }}>
                        Version {instruction.version}
                      </Link>
                      <Badge tone={wireTone(instruction.state)}>
                        {humanizeState(instruction.state)}
                      </Badge>
                    </span>
                  ),
              },
              {
                label: 'Bank details',
                value: instruction === null ? MISSING : instruction.bankDetailsMasked,
              },
            ]}
          />
          <ReleaseStatus ticket={ticket} />
        </>
      )}
    </Card>
  );
}

/** The counterparty's active Verified instruction, masked, with the way to the register (SEC-12.2). */
function WireCard({ wire }: { wire: WireInstructionRow | null }): ReactNode {
  return (
    <Card testId="notice-wire">
      <SectionHeader aside={<Link to="/capital-activity/wires">Wire register</Link>}>
        Wire instruction
      </SectionHeader>
      {wire === null ? (
        <EmptyState
          title="No Verified instruction on file"
          detail="The ticket can be approved only against a Verified instruction (SEC-12.2). Operations propose one in the wire register and a second person verifies it by callback."
        />
      ) : (
        <KeyValueTable
          label="Active wire instruction"
          rows={[
            {
              label: 'Counterparty',
              value: `${wire.counterparty.name} (${kindLabel(wire.counterparty.kind)})`,
            },
            {
              label: 'Version',
              value: (
                <span className="pb-cap-subject">
                  <Link to="/capital-activity/wires/$id" params={{ id: wire.id }}>
                    Version {wire.version}
                  </Link>
                  <Badge tone={wireTone(wire.state)}>{humanizeState(wire.state)}</Badge>
                </span>
              ),
            },
            { label: 'Bank details', value: wire.bankDetailsMasked },
            {
              label: 'Verified on',
              value: wire.verifiedAt === null ? MISSING : formatDateTime(wire.verifiedAt),
            },
            {
              label: 'Callback',
              value:
                wire.callback === null
                  ? MISSING
                  : `${wire.callback.by.name} (${NUMBER_SOURCE_WORDS[wire.callback.numberSource]}, ${RESULT_WORDS[wire.callback.result].toLowerCase()})`,
            },
          ]}
        />
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
  const [drafting, setDrafting] = useState(false);
  const options = commandOptions(capitalNoticeMachine, notice.state, roles);
  const subject = noticeSubject(notice);
  const send = (option: NoticeOption, body: CapitalNoticeCommandBody): void => {
    // The shared hook's body type leaves no room for an undefined reason (exactOptionalPropertyTypes).
    const { reason, ...rest } = body;
    const sent: CommandBody<CapitalNoticeCommand> =
      reason === undefined ? rest : { ...rest, reason };
    command.mutate(
      { id: notice.id, body: sent },
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
  const issue = (option: NoticeOption, reason?: string): void =>
    send(
      option,
      reason === undefined ? { command: option.command } : { command: option.command, reason },
    );
  // A person recording a wire change says why (the API refuses one without a reason).
  const asksReason = (o: NoticeOption): boolean => o.needsReason || o.command === 'wireChanged';
  const draftOption = options.find((o) => o.command === 'draftTicket');
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
            onIssue={(o) =>
              o.command === 'draftTicket'
                ? setDrafting(true)
                : asksReason(o)
                  ? setReasonFor(o)
                  : issue(o)
            }
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
      {drafting && draftOption !== undefined ? (
        <DraftTicketDialog
          notice={notice}
          onCancel={() => setDrafting(false)}
          onSubmit={(values) => {
            send(draftOption, { command: 'draftTicket', ...values });
            setDrafting(false);
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
      <AlertsStrip alerts={notice.alerts} />
      <div ref={balanceTiles} className="pb-tiles" data-testid="notice-tiles">
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
        <TicketCard notice={notice} />
        <WireCard wire={notice.activeWireInstruction} />
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

/**
 * One capital notice through the funding workflow (docs/18 section 3), with its alerts, its
 * trade ticket and release check (SEC-12.3), the counterparty's active instruction (SEC-12.2),
 * its split and cash flows.
 */
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
