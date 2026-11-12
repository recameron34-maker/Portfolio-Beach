import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Field as FluentField, Input, Option } from '@fluentui/react-components';
import type { Principal, WireInstructionCommandBody, WireInstructionDetail } from '@pb/contracts';
import { olderThanVerified } from '@pb/workflows';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { describeActionError } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { ActionLogCard, ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
} from '../../components/ui.js';
import { formatDate, formatDateTime, MISSING } from '../../lib/format.js';
import { humanizeState, rolesLabel } from '../../lib/states.js';
import { MIN_REASON_LENGTH, resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useWireInstructionCommand, wireInstructionQuery, wireInstructionsQuery } from './api.js';
import { WireStateBadge, WireTable } from './WireTable.js';
import {
  CALLBACK_RESULTS,
  CALLBACK_ROLES,
  callbackBody,
  CLEAR_ROLES,
  counterpartyFilter,
  dayOf,
  EMPTY_CALLBACK_FORM,
  isCallbackResult,
  isNumberSource,
  kindLabel,
  maskedParts,
  NUMBER_SOURCE_WORDS,
  NUMBER_SOURCES,
  OLDER_VERSION_RULE,
  RESULT_WORDS,
  SECOND_PERSON_RULE,
  withdrawBody,
} from './wires.js';
import type { CallbackForm } from './wires.js';
import './capital.css';

/** The sentence every clear read carries (SEC-11.1). */
export const AUDITED_READ_NOTE =
  'Each read of the clear details is recorded in the audit trail (SEC-11.1).';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-cap-back">
      <Link to="/capital-activity/wires">Wire instruction register</Link>
    </p>
  );
}

/**
 * What the simulated reveal says (WEB-1): the preview is published, so it carries the masked
 * form of a recorded version only, never a full account number, routing code or reference.
 */
export const PREVIEW_DETAILS_NOTE =
  'Full bank details are not part of this preview: it carries the bank name and the last four digits of the account number only. In the product, operations and approvers read the full details here and each read is recorded in the audit trail (SEC-11.1).';

/** What stands beside details a person typed in the preview session itself. */
const PREVIEW_TYPED_NOTE =
  'These details were typed in this preview session and are shown back to its operations and approver readers only; they are not saved and nothing is audited here.';

/** The value of a field the preview does not carry: withheld, which is not the same as missing. */
const NOT_IN_PREVIEW = 'Not part of the preview';

/** The masked values as the simulated reveal lists them: the two parts the masked form names, the rest withheld. */
function maskedRows(masked: string): { label: string; value: string }[] {
  const parts = maskedParts(masked);
  return [
    ...(parts === null
      ? [{ label: 'Bank details', value: masked }]
      : [
          { label: 'Bank name', value: parts.bankName },
          { label: 'Account number', value: `Ends in ${parts.lastFour}` },
        ]),
    { label: 'Account name', value: NOT_IN_PREVIEW },
    { label: 'Routing code', value: NOT_IN_PREVIEW },
    { label: 'Reference', value: NOT_IN_PREVIEW },
  ];
}

/**
 * The bank details: masked for everyone, and for operations and approvers a toggle that shows
 * the clear fields the audited read answered (SEC-12.2, SEC-11.1). The clear fields never reach
 * the page for any other role: the API answers null. In the preview a recorded version has no
 * clear fields for anyone (WEB-1): its clear readers get the same toggle, which shows the masked
 * values and says the full details are not part of the preview; details a person typed in the
 * session are shown back to them.
 */
function DetailsCard({
  detail,
  clearReader,
}: {
  detail: WireInstructionDetail;
  clearReader: boolean;
}): ReactNode {
  const [revealed, setRevealed] = useState(false);
  const clear = detail.bankDetails;
  const maskedOnly = clear === null && previewMode && clearReader;
  return (
    <Card testId="wire-instruction">
      <SectionHeader>Bank details</SectionHeader>
      <p className="pb-wire-masked" data-testid="wire-masked">
        {detail.bankDetailsMasked}
      </p>
      {clear === null && !maskedOnly ? (
        <p className="pb-meta" data-testid="wire-details-note">
          Bank details in clear are shown to operations and approvers only (SEC-12.2); every other
          role sees the masked form.
        </p>
      ) : (
        <>
          <Button
            size="small"
            appearance="secondary"
            data-testid="wire-details-reveal"
            aria-pressed={revealed}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? 'Hide bank details' : 'Show bank details'}
          </Button>
          {revealed ? (
            <div className="pb-wire-clear">
              {clear === null ? (
                <KeyValueTable
                  label="Bank details in this preview"
                  columns={1}
                  rows={maskedRows(detail.bankDetailsMasked)}
                />
              ) : (
                <KeyValueTable
                  label="Bank details in clear"
                  columns={1}
                  rows={[
                    { label: 'Bank name', value: clear.bankName },
                    { label: 'Account name', value: clear.accountName },
                    { label: 'Account number', value: clear.accountNumber },
                    { label: 'Routing code', value: clear.routingCode },
                    { label: 'Reference', value: clear.reference ?? MISSING },
                  ]}
                />
              )}
            </div>
          ) : null}
          <p className="pb-meta" data-testid="wire-details-note">
            {clear === null
              ? PREVIEW_DETAILS_NOTE
              : previewMode
                ? PREVIEW_TYPED_NOTE
                : revealed
                  ? AUDITED_READ_NOTE
                  : `Shown to operations and approvers only. ${AUDITED_READ_NOTE}`}
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The callback form (docs/18 section 11, SEC-12.2): the number source and the result; a result
 * that confirms verifies the version and makes it active, one that does not rejects it with a
 * reason. The proposer cannot make the callback, and a version older than one already Verified
 * cannot be verified over it, only rejected: the button says so before the API does.
 */
function CallbackFormCard({
  detail,
  canAct,
  isProposer,
  older,
  onLog,
}: {
  detail: WireInstructionDetail;
  canAct: boolean;
  isProposer: boolean;
  /** A newer version of the counterparty is already Verified: this one can only be rejected. */
  older: boolean;
  onLog: ActionLog;
}): ReactNode {
  const command = useWireInstructionCommand();
  const [form, setForm] = useState<CallbackForm>(EMPTY_CALLBACK_FORM);
  const [withdrawing, setWithdrawing] = useState(false);
  const body = callbackBody(form);
  const roleRule = canAct ? null : `Needs ${rolesLabel(CALLBACK_ROLES)}`;
  const blocked =
    roleRule ??
    (isProposer ? SECOND_PERSON_RULE : null) ??
    (older && form.result !== 'not_confirmed' ? OLDER_VERSION_RULE : null);
  const run = (what: string, b: WireInstructionCommandBody): void =>
    command.mutate(
      { id: detail.id, body: b },
      {
        onSuccess: (d) =>
          onLog.record(
            'good',
            `Version ${d.version} for ${d.counterparty.name} is now ${humanizeState(d.state)}${d.active ? ' and active' : ''} ${resultSuffix()}`,
          ),
        onError: (error) => onLog.record('bad', `${what}: ${describeActionError(error)}`),
      },
    );
  return (
    <>
      <form
        data-testid="wire-callback-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (body !== null && blocked === null) run('Record callback', body);
        }}
      >
        <p className="pb-meta">
          Call a number sourced independently of the notice: the instruction already on file, the
          sponsor&apos;s website, a known contact or the fund administrator (SEC-12.2). A confirmed
          callback verifies this version and makes it the active one; one that does not confirm
          rejects it.
        </p>
        {older ? (
          <p className="pb-notice pb-notice-bad" data-testid="wire-older-version">
            {OLDER_VERSION_RULE}. Record a callback that did not confirm, or withdraw the version.
          </p>
        ) : null}
        <div className="pb-wire-form">
          <FluentField label="Number source" required>
            <Dropdown
              placeholder="Choose a source"
              value={form.numberSource === '' ? '' : NUMBER_SOURCE_WORDS[form.numberSource]}
              selectedOptions={form.numberSource === '' ? [] : [form.numberSource]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setForm((f) => ({ ...f, numberSource: isNumberSource(v) ? v : '' }));
              }}
            >
              {NUMBER_SOURCES.map((s) => (
                <Option key={s} value={s} text={NUMBER_SOURCE_WORDS[s]}>
                  {NUMBER_SOURCE_WORDS[s]}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          <FluentField label="Result" required>
            <Dropdown
              placeholder="Choose the result"
              value={form.result === '' ? '' : RESULT_WORDS[form.result]}
              selectedOptions={form.result === '' ? [] : [form.result]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setForm((f) => ({ ...f, result: isCallbackResult(v) ? v : '' }));
              }}
            >
              {CALLBACK_RESULTS.map((r) => (
                <Option key={r} value={r} text={RESULT_WORDS[r]}>
                  {RESULT_WORDS[r]}
                </Option>
              ))}
            </Dropdown>
          </FluentField>
          {form.result === 'not_confirmed' ? (
            <FluentField
              label="Reason"
              required
              hint={`At least ${MIN_REASON_LENGTH} characters; the version is rejected with it.`}
            >
              <Input
                value={form.reason}
                onChange={(_e, d) => setForm((f) => ({ ...f, reason: d.value }))}
              />
            </FluentField>
          ) : null}
        </div>
        <div className="pb-wire-form-actions">
          <Button
            appearance="primary"
            type="submit"
            disabled={blocked !== null || body === null || command.isPending}
            {...(blocked === null ? {} : { title: blocked })}
          >
            {form.result === 'not_confirmed'
              ? 'Record callback and reject'
              : 'Record callback and verify'}
          </Button>
          <Button
            appearance="secondary"
            disabled={roleRule !== null || command.isPending}
            {...(roleRule === null ? {} : { title: roleRule })}
            onClick={() => setWithdrawing(true)}
          >
            Withdraw version
          </Button>
        </div>
      </form>
      {withdrawing ? (
        <ReasonDialog
          title="Withdraw version"
          subject={`Version ${detail.version} for ${detail.counterparty.name}, rejected without a callback`}
          onCancel={() => setWithdrawing(false)}
          onSubmit={(reason) => {
            run('Withdraw version', withdrawBody(reason));
            setWithdrawing(false);
          }}
        />
      ) : null}
    </>
  );
}

function CallbackCard({
  detail,
  me,
  onLog,
}: {
  detail: WireInstructionDetail;
  me: Principal | null;
  onLog: ActionLog;
}): ReactNode {
  const roles = me?.roles ?? [];
  const canAct = roles.some((r) => CALLBACK_ROLES.includes(r));
  const isProposer = me !== null && me.userId === detail.proposedBy.id;
  const callback = detail.callback;
  // The counterparty's versions (the history card reads the same query): a Proposed version
  // older than a Verified one is rejected, never verified over it (docs/18 section 11).
  const versions = useQuery(wireInstructionsQuery(counterpartyFilter(detail.counterparty)));
  const older =
    detail.state === 'Proposed' && olderThanVerified(detail, versions.data?.items ?? []);
  return (
    <Card testId="wire-callback">
      <SectionHeader aside={<SimulatedBadge />}>Callback</SectionHeader>
      {callback === null ? null : (
        <KeyValueTable
          label="Callback"
          columns={1}
          rows={[
            { label: 'By', value: callback.by.name },
            { label: 'At', value: formatDateTime(callback.at) },
            { label: 'Number source', value: NUMBER_SOURCE_WORDS[callback.numberSource] },
            { label: 'Result', value: RESULT_WORDS[callback.result] },
          ]}
        />
      )}
      {detail.verifiedAt === null ? null : (
        <p className="pb-meta">Verified {formatDateTime(detail.verifiedAt)}.</p>
      )}
      {detail.rejectionReason === null ? null : (
        <p className="pb-meta">Rejected: {detail.rejectionReason}</p>
      )}
      {detail.state === 'Proposed' ? (
        <CallbackFormCard
          detail={detail}
          canAct={canAct}
          isProposer={isProposer}
          older={older}
          onLog={onLog}
        />
      ) : callback === null ? (
        <p className="pb-meta">No callback was logged for this version.</p>
      ) : null}
    </Card>
  );
}

/** Every version of the counterparty, newest first, with the one this page is about marked. */
function VersionsCard({ detail }: { detail: WireInstructionDetail }): ReactNode {
  const q = useQuery(wireInstructionsQuery(counterpartyFilter(detail.counterparty)));
  return (
    <Card testId="wire-versions">
      <SectionHeader aside="Newest first">Versions of {detail.counterparty.name}</SectionHeader>
      {q.isPending ? (
        <PageSkeleton rows={2} />
      ) : q.isError ? (
        <UnavailableState inline error={q.error} subject="The version history" />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No other versions" />
      ) : (
        <WireTable
          rows={q.data.items}
          label="Versions of this counterparty"
          showCounterparty={false}
          currentId={detail.id}
        />
      )}
    </Card>
  );
}

function InstructionBody({
  detail,
  me,
}: {
  detail: WireInstructionDetail;
  me: Principal | null;
}): ReactNode {
  const log = useActionLog();
  return (
    <>
      <BackLink />
      <PageHeader
        testId="wire-banner"
        title={`${detail.counterparty.name}: version ${detail.version}`}
        meta={
          <span className="pb-meta-list">
            <span>{kindLabel(detail.counterparty.kind)}</span>
            <span>
              Proposed by {detail.proposedBy.name} on {formatDate(dayOf(detail.proposedAt))}
            </span>
            {detail.sourceNote === null ? null : <span>Source: {detail.sourceNote}</span>}
          </span>
        }
        actions={
          <span className="pb-cap-subject">
            <WireStateBadge state={detail.state} />
            {detail.active ? <Badge tone="good">Active</Badge> : null}
          </span>
        }
      />
      <ActionStatus latest={log.latest} testId="wire-action-status" />
      <div className="pb-two-col">
        <DetailsCard
          detail={detail}
          clearReader={(me?.roles ?? []).some((r) => CLEAR_ROLES.includes(r))}
        />
        <CallbackCard detail={detail} me={me} onLog={log} />
      </div>
      <VersionsCard detail={detail} />
      <ActionLogCard entries={log.entries} />
    </>
  );
}

/**
 * One version of a counterparty's wire instruction (docs/04 M16, docs/18 section 11): the masked
 * details with the audited clear read for operations and approvers, the callback that verified
 * or rejected it (or the form to make it), and the counterparty's version history.
 */
export function WireInstructionPage(): ReactNode {
  const { id } = useParams({ from: '/app/capital-activity/wires/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(wireInstructionQuery(id));
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Wire instruction not found"
            detail="There is no instruction with this id in the register."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This wire instruction"
            forbidden={{
              title: 'This wire instruction: not visible to your role',
              detail:
                'Operations, approvers, auditors and platform admins read the register (SEC-12.2). Ask a platform administrator if you need access.',
            }}
            errorTitle="Wire instruction unavailable"
            testId="wire-unavailable"
          />
        )}
      </>
    );
  }
  return <InstructionBody detail={q.data} me={me.data ?? null} />;
}
