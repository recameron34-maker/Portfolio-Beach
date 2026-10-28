import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type {
  ValuationApproval,
  ValuationCommand,
  ValuationDetail,
  ValuationRow,
  ValuationState,
} from '@pb/contracts';
import { valuationMachine } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { describeActionError, useValuationCommand } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import {
  ActionLogCard,
  ActionStatus,
  CommandButtons,
  ReasonDialog,
} from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  formatPct,
  labelOf,
  MISSING,
  plural,
} from '../../lib/format.js';
import {
  changeRequestTone,
  commandLabel,
  commandOptions,
  humanizeState,
  valuationTone,
} from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { valuationDetailQuery } from './api.js';
import {
  aboveVarianceFlag,
  approvedOn,
  valuationSteps,
  VARIANCE_TITLE,
  versionLabel,
} from './board.js';
import './valuations.css';

type ValuationOption = CommandOption<ValuationState, ValuationCommand>;

/** The approval steps of mon.valuation_approval in words. */
const STEP_WORDS: Readonly<Record<ValuationApproval['step'], string>> = {
  ops_prepared: 'Ops prepared',
  deal_team: 'Deal team',
  final: 'Final approval',
  reopen: 'Reopen',
};

const DECISION_WORDS: Readonly<Record<ValuationApproval['decision'], string>> = {
  approve: 'Approved',
  reject: 'Sent back',
  reopen: 'Reopened',
};

const DECISION_TONES: Readonly<Record<ValuationApproval['decision'], 'good' | 'watch' | 'bad'>> = {
  approve: 'good',
  reject: 'bad',
  reopen: 'watch',
};

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-val-back">
      <Link to="/valuations">Valuation board</Link>
    </p>
  );
}

function ProgressStrip({ state }: { state: ValuationState }): ReactNode {
  return (
    <ol className="pb-val-progress" aria-label="Valuation progress">
      {valuationSteps(state).map((step, i) => (
        <li
          key={step.state}
          data-status={step.status}
          {...(step.status === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span className="pb-val-step">
            <span className="pb-val-step-number" aria-hidden="true">
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

function Tiles({ detail }: { detail: ValuationDetail }): ReactNode {
  const variance = aboveVarianceFlag(detail.changePct);
  const final = detail.approvals.find((a) => a.step === 'final' && a.decision === 'approve');
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="valuation-detail-tiles">
      <StatTile
        label="Fair value"
        value={formatMoneyM(detail.fairValue)}
        hint={labelOf(detail.method)}
      />
      <StatTile
        label="Prior fair value"
        value={formatMoneyM(detail.priorFairValue)}
        hint={
          detail.priorFairValue === null
            ? 'No Locked mark for the prior quarter'
            : 'Prior quarter, Locked'
        }
      />
      <StatTile
        label="Change"
        value={formatPct(detail.changePct)}
        hint={variance ? VARIANCE_TITLE : 'Against the prior Locked mark'}
        tone={variance ? 'watch' : undefined}
      />
      <StatTile
        label="Locked"
        value={approvedOn(detail.approvedAt)}
        hint={final === undefined ? 'Not locked' : `By ${final.actorName}`}
      />
    </div>
  );
}

function WorkflowCard({
  detail,
  roles,
  log,
}: {
  detail: ValuationDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const command = useValuationCommand();
  const [reasonFor, setReasonFor] = useState<ValuationOption | null>(null);
  const [reopenedTo, setReopenedTo] = useState<ValuationRow | null>(null);
  const options = commandOptions(valuationMachine, detail.state, roles);
  const subject = versionLabel(detail);
  const issue = (option: ValuationOption, reason?: string): void => {
    command.mutate(
      {
        id: detail.id,
        body:
          reason === undefined ? { command: option.command } : { command: option.command, reason },
      },
      {
        onSuccess: (updated) => {
          // A reopen answers with the next Draft version, never the version reopened.
          if (option.command === 'reopen') {
            setReopenedTo(updated);
            log.record(
              'good',
              `${subject} is now Reopened; the new Draft version is ${versionLabel(updated)} ${resultSuffix()}`,
            );
          } else {
            log.record(
              'good',
              `${versionLabel(updated)} is now ${humanizeState(updated.state)} ${resultSuffix()}`,
            );
          }
        },
        onError: (error) =>
          log.record(
            'bad',
            `${commandLabel(option.command)} for ${subject}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const notes = options.filter((o) => o.note !== undefined);
  return (
    <Card testId="valuation-workflow">
      <SectionHeader aside={previewMode ? <SimulatedBadge /> : undefined}>Workflow</SectionHeader>
      <ActionStatus latest={log.latest} testId="valuation-action-status" />
      {reopenedTo === null ? null : (
        <p className="pb-notice pb-notice-good" data-testid="valuation-reopened">
          Reopened into a new Draft:{' '}
          <Link to="/valuations/$id" params={{ id: reopenedTo.id }}>
            {versionLabel(reopenedTo)}
          </Link>
        </p>
      )}
      {options.length === 0 ? (
        <p className="pb-meta">
          {detail.state === 'Reopened'
            ? 'Reopened is the last step of this version; the work continues on the next Draft version.'
            : `${humanizeState(detail.state)} is the last step; nothing further to do.`}
        </p>
      ) : (
        <div className="pb-val-actions">
          <CommandButtons
            options={options}
            busy={command.isPending}
            appearance="secondary"
            onIssue={(o) => (o.needsReason ? setReasonFor(o) : issue(o))}
          />
        </div>
      )}
      {notes.length > 0 ? (
        <ul className="pb-list">
          {notes.map((o) => (
            <li key={o.command} className="pb-meta">
              {commandLabel(o.command)}: {o.note}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.reopenReason === null ? null : (
        <p className="pb-meta">Reopen reason: {detail.reopenReason}</p>
      )}
      {reasonFor !== null ? (
        <ReasonDialog
          title={commandLabel(reasonFor.command)}
          subject={subject}
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

/** The exact text the lock hash covers and the hash itself (docs/18 section 1, SEC-5.6, SEC-9.3). */
function LockCard({ detail }: { detail: ValuationDetail }): ReactNode {
  return (
    <Card testId="valuation-lock">
      <SectionHeader>Lock</SectionHeader>
      {detail.lockText === null ? (
        <EmptyState
          title="Not locked"
          detail="The lock text and its hash appear once an approver locks the version. Reports read Locked versions only."
        />
      ) : (
        <>
          <p className="pb-meta">
            The hash is SHA-256 over this text: the version identity, the method and the fair value.
            A Locked version never changes in place; a correction reopens it into a new version.
          </p>
          <pre className="pb-val-lock" data-testid="valuation-lock-text">
            {detail.lockText}
          </pre>
          <p className="pb-meta">
            Hash: <code className="pb-val-hash">{detail.lockHash ?? MISSING}</code>
          </p>
        </>
      )}
    </Card>
  );
}

function ApprovalsCard({ approvals }: { approvals: readonly ValuationApproval[] }): ReactNode {
  return (
    <Card testId="valuation-approvals">
      <SectionHeader
        aside={approvals.length === 0 ? undefined : plural(approvals.length, 'decision')}
      >
        Approvals
      </SectionHeader>
      {approvals.length === 0 ? (
        <EmptyState
          title="No decisions yet"
          detail="Each prepare, approval, send back, lock and reopen is recorded here with who decided and why."
        />
      ) : (
        <TableWrap label="Approvals">
          <table className="pb-table" aria-label="Approvals">
            <thead>
              <tr>
                <th>Step</th>
                <th>Decision</th>
                <th>By</th>
                <th>When</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td>{STEP_WORDS[a.step]}</td>
                  <td>
                    <Badge tone={DECISION_TONES[a.decision]}>{DECISION_WORDS[a.decision]}</Badge>
                  </td>
                  <td>{a.actorName}</td>
                  <td className="pb-nowrap">{formatDateTime(a.at)}</td>
                  <td>{a.reason ?? MISSING}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/** The open change requests of the version's investment (M11): what may still move the mark. */
function OpenChangesCard({ detail }: { detail: ValuationDetail }): ReactNode {
  const rows = detail.openChangeRequests;
  return (
    <Card testId="valuation-open-changes">
      <SectionHeader aside={rows.length === 0 ? undefined : plural(rows.length, 'open request')}>
        Open change requests
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No open change requests"
          detail="Every change request on this position is applied or rejected."
        />
      ) : (
        <TableWrap label="Open change requests">
          <table className="pb-table" aria-label="Open change requests">
            <thead>
              <tr>
                <th>Change</th>
                <th>Effective</th>
                <th>Summary</th>
                <th>Owner</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{labelOf(r.changeType)}</td>
                  <td className="pb-nowrap">{formatDate(r.effectiveDate)}</td>
                  <td>{r.summary}</td>
                  <td>{r.owner?.name ?? MISSING}</td>
                  <td>
                    <Badge tone={changeRequestTone(r.state)}>{humanizeState(r.state)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <p className="pb-meta">
        <Link to="/valuations/changes">Open the change request queue</Link>
      </p>
    </Card>
  );
}

function DetailBody({
  detail,
  roles,
}: {
  detail: ValuationDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  return (
    <div data-testid="valuation-detail">
      <BackLink />
      <PageHeader
        testId="valuation-banner"
        title={`${detail.companyName}: ${formatDate(detail.periodEnd)} v${detail.version}`}
        meta={
          <span className="pb-meta-list">
            <span>
              <Link to="/portfolio/$id" params={{ id: detail.investmentId }}>
                {detail.investmentNumber}
              </Link>
            </span>
            <span>{detail.vehicleName}</span>
            <span>{labelOf(detail.dealType)}</span>
            <span>Quarter {formatDate(detail.quarterEnd)}</span>
          </span>
        }
        actions={<Badge tone={valuationTone(detail.state)}>{humanizeState(detail.state)}</Badge>}
      />
      <ProgressStrip state={detail.state} />
      <Tiles detail={detail} />
      <div className="pb-two-col">
        <WorkflowCard detail={detail} roles={roles} log={log} />
        <LockCard detail={detail} />
      </div>
      <div className="pb-two-col">
        <ApprovalsCard approvals={detail.approvals} />
        <OpenChangesCard detail={detail} />
      </div>
      <ActionLogCard entries={log.entries} />
    </div>
  );
}

/**
 * One valuation version (docs/04 M10, docs/18 section 1): its place in the workflow, the figures
 * against the prior Locked mark, the commands the signed-in roles may issue, the lock text with
 * its hash, the approval trail and the open change requests of its investment.
 */
export function ValuationDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/valuations/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(valuationDetailQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <>
        <BackLink />
        {hidden ? (
          <ErrorState
            title="Valuation not found or not visible to you"
            detail="There is no valuation version with this id in your view of the portfolio."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This valuation"
            errorTitle="Valuation unavailable"
            testId="valuation-unavailable"
          />
        )}
      </>
    );
  }
  return <DetailBody detail={q.data} roles={me.data?.roles ?? []} />;
}
