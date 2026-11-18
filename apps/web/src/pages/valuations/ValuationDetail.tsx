import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import { canonicalJson } from '@pb/contracts';
import type {
  ValuationApproval,
  ValuationCommand,
  ValuationDetail,
  ValuationEditBody,
  ValuationRow,
  ValuationState,
} from '@pb/contracts';
import { valuationMachine } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { SUGGESTIONS_PATH } from '../../app/nav.js';
import { useValuationCommand } from '../../app/mutations.js';
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
import { blockedTitle, resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  describeValuationError,
  useEditValuation,
  useRefreshIfVersionTaken,
  valuationDetailQuery,
} from './api.js';
import {
  aboveVarianceFlag,
  approvedOn,
  canEditDraft,
  changedParts,
  EDIT_ROLES,
  isInFlight,
  lockedBy,
  signOffsOf,
  valuationSteps,
  VARIANCE_TITLE,
  versionLabel,
} from './board.js';
import { EditValuationDialog } from './EditValuation.js';
import { suggestionsQuery } from './suggestions-api.js';
import {
  canReadSuggestions,
  NEWER_SUGGESTION,
  splitSuggestionKeys,
  startedFromSentence,
  suggestionFacts,
  suggestionOnDraft,
} from './suggestions.js';
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
  // The final approval of the trail, or the approver named on the version when it holds no
  // decision rows (a version loaded with its sign-offs is Locked all the same).
  const locker = lockedBy(detail);
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
        hint={locker === null ? 'Not locked' : `By ${locker}`}
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
  const edit = useEditValuation();
  const refreshIfVersionTaken = useRefreshIfVersionTaken();
  const [reasonFor, setReasonFor] = useState<ValuationOption | null>(null);
  const [reopenedTo, setReopenedTo] = useState<ValuationRow | null>(null);
  // The version as it read when the form was opened: the edit carries that row version, so a
  // change someone else made meanwhile is refused (412), never overwritten by a form that did
  // not show it.
  const [editing, setEditing] = useState<ValuationDetail | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const options = commandOptions(valuationMachine, detail.state, roles);
  const subject = versionLabel(detail);
  // Only a Draft is edited (docs/18 section 1), by the roles the route table names.
  const editBlocked = blockedTitle({ allowed: canEditDraft(roles), roles: EDIT_ROLES });
  const saveEdit = (opened: ValuationDetail, body: ValuationEditBody): void => {
    edit.mutate(
      { id: opened.id, body, rowVersion: opened.rowVersion },
      {
        onSuccess: (updated) => {
          setEditing(null);
          setEditError(null);
          log.record(
            'good',
            `${versionLabel(updated)} corrected: ${changedParts(body)} ${resultSuffix()}`,
          );
        },
        // The dialog stays open with the reason, so what was typed is not lost.
        onError: (error) => {
          const why = describeValuationError(error);
          setEditError(why);
          log.record('bad', `Edit draft for ${subject}: ${why}`);
        },
      },
    );
  };
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
        onError: (error) => {
          refreshIfVersionTaken(error);
          log.record(
            'bad',
            `${commandLabel(option.command)} for ${subject}: ${describeValuationError(error)}`,
          );
        },
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
            busy={command.isPending || edit.isPending}
            appearance="secondary"
            onIssue={(o) => (o.needsReason ? setReasonFor(o) : issue(o))}
          />
          {detail.state === 'Draft' ? (
            <Button
              size="small"
              appearance="secondary"
              disabled={editBlocked !== null || command.isPending || edit.isPending}
              {...(editBlocked === null ? {} : { title: editBlocked })}
              onClick={() => {
                setEditError(null);
                setEditing(detail);
              }}
            >
              Edit draft
            </Button>
          ) : null}
        </div>
      )}
      {detail.state === 'Draft' ? (
        <p className="pb-meta">
          Edit draft: operations corrects the method, the fair value and the method inputs before
          preparing the version. Only a Draft can be edited.
        </p>
      ) : null}
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
      {editing === null ? null : (
        <EditValuationDialog
          detail={editing}
          busy={edit.isPending}
          error={editError}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => saveEdit(editing, body)}
        />
      )}
    </Card>
  );
}

/** A stored input as the screen shows it: text and numbers as they are, anything else as its JSON. */
function inputText(value: unknown): string {
  if (typeof value === 'string') return value === '' ? MISSING : value;
  if (typeof value === 'number') return String(value);
  try {
    return canonicalJson(value);
  } catch {
    return MISSING;
  }
}

/**
 * The method inputs of the version (mon.valuation.inputs): what the value rests on. They are
 * shown in every state, since the lock covers them: whoever approves reads what will be locked,
 * and operations edits them while the version is a Draft.
 */
function InputsCard({ detail }: { detail: ValuationDetail }): ReactNode {
  // What a suggestion wrote is said in words; its identifiers are the links of the note above.
  const { own, kept } = splitSuggestionKeys(detail.inputs);
  const rows = Object.entries(own).sort(([a], [b]) => a.localeCompare(b));
  const facts = suggestionFacts(kept);
  const count = rows.length + facts.length;
  return (
    <Card testId="valuation-inputs">
      <SectionHeader aside={count === 0 ? undefined : plural(count, 'input')}>
        Method inputs
      </SectionHeader>
      {count === 0 ? (
        <EmptyState
          title="No method inputs"
          detail={
            detail.state === 'Draft'
              ? 'Operations can add what the value rests on with Edit draft. The lock covers the inputs with the method and the fair value.'
              : 'This version holds the method and the fair value only. The lock covers them, with no inputs.'
          }
        />
      ) : (
        <>
          {rows.length === 0 ? null : (
            <TableWrap label="Method inputs">
              <table className="pb-table" aria-label="Method inputs">
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([name, value]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{inputText(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {facts.length === 0 ? null : (
            <>
              <h3 className="pb-val-sub">From the suggestion</h3>
              <TableWrap label="From the suggestion">
                <table className="pb-table" aria-label="From the suggestion">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facts.map((fact) => (
                      <tr key={fact.label}>
                        <td>{fact.label}</td>
                        <td>{fact.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          )}
          <p className="pb-meta">The lock covers these with the method and the fair value.</p>
        </>
      )}
    </Card>
  );
}

/** The exact text the lock hash covers and the hash itself (docs/18 section 1, SEC-5.6, SEC-9.3). */
function LockCard({ detail }: { detail: ValuationDetail }): ReactNode {
  return (
    <Card testId="valuation-lock">
      <SectionHeader>Lock</SectionHeader>
      {detail.lockText === null && detail.state === 'Reopened' && detail.lockHash !== null ? (
        <>
          <EmptyState
            title="Reopened after its lock"
            detail="This version was Locked and then reopened, so reports no longer read it. The work continues on the next version, which gets a lock of its own."
          />
          <p className="pb-meta">
            The hash it was locked with: <code className="pb-val-hash">{detail.lockHash}</code>
          </p>
        </>
      ) : detail.lockText === null ? (
        <EmptyState
          title="Not locked"
          detail="The lock text and its hash appear once an approver locks the version. Reports read Locked versions only."
        />
      ) : (
        <>
          <p className="pb-meta">
            The hash is SHA-256 over this text: the version identity, the method, the method inputs
            and the fair value. A Locked version never changes in place; a correction reopens it
            into a new version.
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

/**
 * The approval trail (mon.valuation_approval). A version that holds no decision rows but names
 * its preparer and approvers (one loaded with its sign-offs, such as the seeded history) shows
 * those names with the lock time, so a Locked version never reads as undecided; the time of a
 * step the version does not carry is the missing placeholder, never a guess (rule 10).
 */
function ApprovalsCard({ detail }: { detail: ValuationDetail }): ReactNode {
  const { approvals } = detail;
  const signOffs = signOffsOf(detail);
  return (
    <Card testId="valuation-approvals">
      <SectionHeader
        aside={
          approvals.length > 0
            ? plural(approvals.length, 'decision')
            : signOffs.length > 0
              ? plural(signOffs.length, 'sign-off')
              : undefined
        }
      >
        Approvals
      </SectionHeader>
      {approvals.length === 0 && signOffs.length > 0 ? (
        <>
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
                {signOffs.map((s) => (
                  <tr key={s.step}>
                    <td>{STEP_WORDS[s.step]}</td>
                    <td>
                      <Badge tone={DECISION_TONES.approve}>{DECISION_WORDS.approve}</Badge>
                    </td>
                    <td>{s.by}</td>
                    <td className="pb-nowrap">{s.at === null ? MISSING : formatDateTime(s.at)}</td>
                    <td>{MISSING}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="pb-meta">
            These names are on the version itself; it holds no step by step decisions.
          </p>
        </>
      ) : approvals.length === 0 ? (
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

/**
 * What a suggestion has to do with this version (decision 0023): the suggestion its value was
 * started from, read from the inputs the lock will cover, with the document it came from; and,
 * while the version is still being worked on, a suggestion open for its quarter that is not the
 * one it started from. The second is read for the roles that read suggestions and nobody else.
 */
function SuggestionNotes({
  detail,
  roles,
}: {
  detail: ValuationDetail;
  roles: readonly string[];
}): ReactNode {
  const started = suggestionOnDraft(detail.inputs);
  const reader = canReadSuggestions(roles);
  const open = useQuery({
    ...suggestionsQuery({ investmentId: detail.investmentId, periodEnd: detail.quarterEnd }),
    enabled: reader && isInFlight(detail.state),
  });
  const other = open.data?.items.find((row) => row.state === 'Open' && row.id !== started?.id);
  if (started === null && other === undefined) return null;
  return (
    <div className="pb-val-gates">
      {started === null ? null : (
        <p className="pb-notice" data-testid="valuation-from-suggestion">
          {/* One child, so the links stay inside the sentence: a notice lays its children out in a row. */}
          <span>
            {startedFromSentence(started)}{' '}
            {started.documentId === null ? null : started.page === null ? (
              // No figure was read from a page of it: typed by the reviewer, or the record's.
              <>
                Raised when{' '}
                <Link to="/documents/$id" params={{ id: started.documentId }}>
                  this document
                </Link>{' '}
                was approved.{' '}
              </>
            ) : (
              <>
                <Link to="/documents/$id" params={{ id: started.documentId }}>
                  Source document
                </Link>
                {`, page ${started.page}.`}{' '}
              </>
            )}
            {reader ? (
              <Link to={SUGGESTIONS_PATH} search={{ id: started.id }}>
                Open the suggestion
              </Link>
            ) : null}
          </span>
        </p>
      )}
      {other === undefined ? null : (
        <p className="pb-notice" data-testid="valuation-newer-suggestion">
          <span>
            {started === null ? 'A suggestion is open for this quarter.' : NEWER_SUGGESTION}{' '}
            <Link to={SUGGESTIONS_PATH} search={{ id: other.id }}>
              Open it
            </Link>
          </span>
        </p>
      )}
    </div>
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
      <SuggestionNotes detail={detail} roles={roles} />
      <div className="pb-two-col">
        <WorkflowCard detail={detail} roles={roles} log={log} />
        <InputsCard detail={detail} />
      </div>
      <div className="pb-two-col">
        <LockCard detail={detail} />
        <ApprovalsCard detail={detail} />
      </div>
      <div className="pb-two-col">
        <OpenChangesCard detail={detail} />
        <ActionLogCard entries={log.entries} />
      </div>
    </div>
  );
}

/**
 * One valuation version (docs/04 M10, docs/18 section 1): its place in the workflow, the figures
 * against the prior Locked mark, the commands the signed-in roles may issue and the edit of a
 * Draft, the method inputs, the lock text with its hash, the approval trail and the open change
 * requests of its investment.
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
