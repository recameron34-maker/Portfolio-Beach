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
import { plainWords } from '../../components/plain-words.js';
import { StepStrip } from '../../components/StepStrip.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Breadcrumbs,
  Card,
  EmptyLine,
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
import {
  ALERT_WORDS,
  BLOCKER_WORDS,
  instructionWithheld,
  nothingToRelease,
  REGISTER_RESTRICTED,
  RELEASE_ALLOWED,
} from './tickets.js';
import { ticketTone, wireTone } from '../../lib/states.js';
import { kindLabel, NUMBER_SOURCE_WORDS, RESULT_WORDS } from './wires.js';
import './capital.css';
import { balanceTiles } from '../../lib/tiles.js';

type NoticeOption = CommandOption<CapitalNoticeState, CapitalNoticeCommand>;

const BANK_DETAILS =
  'Bank details are never extracted from documents; tickets release only against a Verified instruction.';

/** Where a notice sits: Capital activity, then its notices. */
const TRAIL = [
  { label: 'Capital activity', to: '/capital-activity' },
  { label: 'Notices', to: '/capital-activity' },
];

/** The commands that move a notice on; recording a wire change is not one of them. */
const FORWARD: ReadonlySet<CapitalNoticeCommand> = new Set([
  'extract',
  'review',
  'draftTicket',
  'approveTicket',
  'confirmFunding',
  'reconcile',
]);

/** The seven states of docs/18 section 3 in the shared step strip. */
function ProgressStrip({ state }: { state: CapitalNoticeState }): ReactNode {
  return (
    <StepStrip
      label="Notice progress"
      steps={progressSteps(state).map((step) => ({
        key: step.state,
        label: humanizeState(step.state),
        status: step.status,
      }))}
    />
  );
}

/**
 * The hold and the SEC-12.4 alerts in one block under the header, each line a dot, a word and
 * its sentence. It takes the bad band once, when a hold or a bad alert stands; otherwise it is
 * plain lines, or the one line that no alert stands.
 */
function HoldsAndAlerts({ notice }: { notice: CapitalNoticeDetail }): ReactNode {
  const hold = notice.wireChangeHold;
  const alerts = notice.alerts;
  const bad = hold !== null || alerts.some((a) => ALERT_WORDS[a].tone === 'bad');
  return (
    <section className={bad ? 'pb-cap-holds is-bad' : 'pb-cap-holds'} aria-label="Holds and alerts">
      {hold === null ? null : (
        <p className="pb-cap-hold-line" data-testid="wire-hold">
          <Badge tone="bad">Held</Badge>
          <span>
            Wire instructions changed within the hold window. Ticket approval is held until{' '}
            {formatDate(hold.until)} ({hold.holdDays} days).
          </span>
        </p>
      )}
      <div data-testid="notice-alerts">
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
    </section>
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
        <EmptyLine
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
                  <td className="pb-nowrap">
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

/**
 * Whether the ticket can be released now, or every reason it cannot, in words (SEC-12.3): a dot
 * and a sentence a line, with no box (the holds and alerts above carry the page's one band).
 */
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
      <p className="pb-cap-release pb-cap-dot-line" data-testid="ticket-release">
        <span className="pb-cap-dot is-good" aria-hidden="true" />
        <span>{RELEASE_ALLOWED}</span>
      </p>
    );
  }
  return (
    <div className="pb-cap-release" data-testid="ticket-release">
      <p className="pb-cap-release-title">Release is blocked:</p>
      <ul className="pb-cap-dot-list" aria-label="Release blockers">
        {ticket.release.blockers.map((b) => (
          <li key={b}>
            <span className="pb-cap-dot is-bad" aria-hidden="true" />
            <span>{BLOCKER_WORDS[b]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function personAt(person: { name: string } | null, at: string | null): string {
  if (person === null || at === null) return MISSING;
  return `${person.name}, ${formatDateTime(at)}`;
}

/**
 * The notice's trade ticket (docs/04 M16): the figures, the people and the release check. The
 * version it was approved against is a register row, so a reader outside the register sees that
 * it is restricted, never the missing placeholder.
 */
function TicketCard({ notice }: { notice: CapitalNoticeDetail }): ReactNode {
  const ticket = notice.ticket;
  const instruction = ticket?.wireInstruction ?? null;
  const absent = ticket !== null && instructionWithheld(ticket) ? REGISTER_RESTRICTED : MISSING;
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
        <EmptyLine
          title="No trade ticket yet"
          detail="Draft ticket creates one from the notice's amount and due date. The preparer and the approver must differ."
        />
      ) : (
        <>
          <KeyValueTable
            label="Trade ticket"
            columns={1}
            rows={[
              { label: 'Amount', value: noticeAmount(ticket.amount, ticket.currency) },
              {
                label: 'Funding date',
                value: <span className="pb-nowrap">{formatDate(ticket.fundingDate)}</span>,
              },
              { label: 'Prepared by', value: personAt(ticket.preparedBy, ticket.preparedAt) },
              { label: 'Approved by', value: personAt(ticket.approvedBy, ticket.approvedAt) },
              {
                label: 'Instruction version',
                value:
                  instruction === null ? (
                    absent
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
                value: instruction === null ? absent : instruction.bankDetailsMasked,
              },
            ]}
          />
          <ReleaseStatus ticket={ticket} />
        </>
      )}
    </Card>
  );
}

/**
 * The counterparty's active Verified instruction, masked, with the way to the register
 * (SEC-12.2). The API hands the row to the register's readers only (operations, approvers,
 * auditors, platform admins); every other reader gets null whether or not one is on file, so
 * the card decides from the alerts: unverified_instruction says none is on file, and without
 * that alert one is on file and the card says the register is restricted.
 */
function WireCard({
  wire,
  alerts,
}: {
  wire: WireInstructionRow | null;
  alerts: readonly CapitalNoticeAlert[];
}): ReactNode {
  const restricted = wire === null && !alerts.includes('unverified_instruction');
  return (
    <Card testId="notice-wire">
      <SectionHeader
        aside={restricted ? undefined : <Link to="/capital-activity/wires">Wire register</Link>}
      >
        Wire instruction
      </SectionHeader>
      {restricted ? (
        <EmptyLine
          title="A Verified instruction is on file"
          detail="Its details are kept in the wire register, which operations, approvers, auditors and platform admins read. The alerts and the release check on this page already take it into account."
        />
      ) : wire === null ? (
        <EmptyLine
          title="No Verified instruction on file"
          detail="The ticket can be approved only against a Verified instruction. Operations propose one in the wire register and a second person verifies it by callback."
        />
      ) : (
        <KeyValueTable
          label="Active wire instruction"
          columns={1}
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

/**
 * The notice's commands directly under the header, with no heading or frame: the command that
 * moves the notice on leads, why a command is blocked reads under the buttons, and the result
 * line, the last-step sentence, the command notes and the bank details rule follow as quiet lines.
 */
function CommandBlock({
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
  const forward = options.find((o) => FORWARD.has(o.command))?.command;
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
    <div className="pb-command-block" data-testid="notice-workflow">
      {options.length === 0 ? (
        <p className="pb-meta">
          {humanizeState(notice.state)} is the last step; nothing further to do.
        </p>
      ) : (
        <div className="pb-command-row">
          <CommandButtons
            options={options}
            busy={command.isPending}
            appearance="secondary"
            size="medium"
            primary={forward}
            showBlockedReason
            notAllowedTitle={(o) => (o.command === 'extract' ? 'Service accounts only' : undefined)}
            onIssue={(o) =>
              o.command === 'draftTicket'
                ? setDrafting(true)
                : asksReason(o)
                  ? setReasonFor(o)
                  : issue(o)
            }
          />
          {previewMode ? <SimulatedBadge /> : null}
        </div>
      )}
      <ActionStatus latest={onLog.latest} testId="notice-action-status" />
      {notes.map((o) => (
        <p key={o.command} className="pb-note">
          {commandLabel(o.command)}: {plainWords(o.note ?? '')}
        </p>
      ))}
      <p className="pb-note" data-testid="bank-details-note">
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
    </div>
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
  return (
    <>
      <PageHeader
        testId="notice-banner"
        crumbs={TRAIL}
        title={`${labelOf(notice.noticeType)}: ${subject}`}
        titleAside={<Badge tone={noticeTone(notice.state)}>{humanizeState(notice.state)}</Badge>}
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
      />
      <CommandBlock notice={notice} roles={roles} onLog={log} />
      <ProgressStrip state={notice.state} />
      <HoldsAndAlerts notice={notice} />
      <div ref={balanceTiles} className="pb-tiles" data-testid="notice-tiles">
        <StatTile
          label="Amount"
          value={noticeAmount(notice.amount, notice.currency)}
          hint={notice.currency}
        />
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
      </div>
      <div className="pb-two-col">
        <TicketCard notice={notice} />
        <WireCard wire={notice.activeWireInstruction} alerts={notice.alerts} />
      </div>
      <div className="pb-two-col">
        <Card testId="notice-split">
          <SectionHeader>Split</SectionHeader>
          {splits.length === 0 ? (
            <EmptyLine
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
      <div className="pb-two-col">
        <Card testId="notice-notes">
          <SectionHeader>Notes</SectionHeader>
          {notice.notes.length === 0 ? (
            <EmptyLine title="No notes" />
          ) : (
            <ul className="pb-list">
              {notice.notes.map((note, i) => (
                <li key={i}>{plainWords(note)}</li>
              ))}
            </ul>
          )}
        </Card>
        <ActionLogCard entries={log.entries} />
      </div>
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
        <Breadcrumbs items={TRAIL} />
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
