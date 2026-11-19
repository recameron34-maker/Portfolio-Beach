import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field as FluentField,
  Input,
  Option,
} from '@fluentui/react-components';
import { uuid } from '@pb/contracts';
import type { ClosingDetail, ClosingItem, ClosingItemCommandBody, LegalTerm } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError } from '../../app/mutations.js';
import { documentsOfInvestmentQuery, documentsQuery, taxonomyQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValueTable,
  Notice,
  NumCell,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TableWrap,
} from '../../components/ui.js';
import { ActionLogCard, ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  labelOf,
  MISSING,
  plural,
} from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import {
  blockedTitle,
  isReason,
  MIN_REASON_LENGTH,
  resultSuffix,
  useActionLog,
} from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { AllocationLinesTable } from './AllocationLines.js';
import {
  closingQuery,
  useClosingCommand,
  useClosingItemCommand,
  useCreateLegalTerm,
  useLegalTermCommand,
} from './api.js';
import {
  closingBlockers,
  closingLock,
  isIsoDate,
  itemStatusTone,
  mayUse,
  personName,
  PIPELINE_ROLES,
  termsOf,
  termStatusTone,
  termValueOf,
  tieOutLabel,
  tieOutTone,
} from './pipeline.js';
import type { TermField } from './pipeline.js';
import { closingTone } from '../../lib/states.js';
import './pipeline.css';
import { dialogSurfaceMotion, useJustChanged, useReducedMotion } from '../../components/motion.js';

const CLOSE_DATE_RULE =
  'The close date is the single source for every report. A change after confirmation returns the closing to Open and needs confirmation again.';

const REOPEN_RULE =
  'Reopening returns the record to Open so the checklist and the allocations can change; operations confirm again.';

/** A new close date with the reason the audit trail keeps (docs/04 M8). */
function CloseDateDialog({
  closing,
  onCancel,
  onSubmit,
}: {
  closing: ClosingDetail;
  onCancel: () => void;
  onSubmit: (closeDate: string, reason: string) => void;
}): ReactNode {
  const [closeDate, setCloseDate] = useState(closing.closeDate);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const ready = isIsoDate(closeDate) && closeDate !== closing.closeDate && isReason(reason);
  const motion = dialogSurfaceMotion(useReducedMotion());
  return (
    <Dialog
      surfaceMotion={motion}
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface className="pb-dialog" backdrop={{ className: 'pb-dialog-backdrop' }}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ready) onSubmit(closeDate, reason.trim());
          }}
        >
          <DialogBody>
            <DialogTitle>Change close date</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">
                Now {formatDate(closing.closeDate)}. {CLOSE_DATE_RULE}
              </p>
              <FluentField
                label="New close date"
                required
                {...(touched && (!isIsoDate(closeDate) || closeDate === closing.closeDate)
                  ? {
                      validationState: 'error' as const,
                      validationMessage: 'Give a date other than the current close date.',
                    }
                  : {})}
              >
                <Input type="date" value={closeDate} onChange={(_e, d) => setCloseDate(d.value)} />
              </FluentField>
              <FluentField
                label="Reason"
                required
                hint={`At least ${MIN_REASON_LENGTH} characters; kept on the audit event.`}
                {...(touched && !isReason(reason)
                  ? {
                      validationState: 'error' as const,
                      validationMessage: `Give a reason of at least ${MIN_REASON_LENGTH} characters.`,
                    }
                  : {})}
              >
                <Input value={reason} onChange={(_e, d) => setReason(d.value)} />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ready}>
                Change close date
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Marks an item received with its document: the position's documents when the closing already
 * names one, otherwise the hub's first page; an id can also be typed from the hub.
 */
function ReceiveDialog({
  item,
  investmentId,
  onCancel,
  onSubmit,
}: {
  item: ClosingItem;
  investmentId: string | null;
  onCancel: () => void;
  onSubmit: (documentId: string) => void;
}): ReactNode {
  const ofInvestment = useQuery({
    ...documentsOfInvestmentQuery(investmentId ?? ''),
    enabled: investmentId !== null,
  });
  const hub = useInfiniteQuery({ ...documentsQuery({}), enabled: investmentId === null });
  const documents =
    investmentId === null ? (hub.data?.pages[0]?.items ?? []) : (ofInvestment.data?.items ?? []);
  const [documentId, setDocumentId] = useState('');
  const id = documentId.trim();
  const ok = uuid.safeParse(id).success;
  const chosen = documents.find((d) => d.id === id);
  const motion = dialogSurfaceMotion(useReducedMotion());
  return (
    <Dialog
      surfaceMotion={motion}
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface className="pb-dialog" backdrop={{ className: 'pb-dialog-backdrop' }}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onSubmit(id);
          }}
        >
          <DialogBody>
            <DialogTitle>Receive item</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{item.label}</p>
              <FluentField
                label="Document"
                hint={
                  documents.length === 0
                    ? 'No documents listed; type the document id from the hub below.'
                    : investmentId === null
                      ? 'The hub, newest first.'
                      : "The position's documents, newest first."
                }
              >
                <Dropdown
                  placeholder="Choose a document"
                  value={chosen?.title ?? ''}
                  selectedOptions={chosen === undefined ? [] : [chosen.id]}
                  onOptionSelect={(_e, d) => setDocumentId(d.optionValue ?? '')}
                >
                  {documents.map((d) => (
                    <Option key={d.id} value={d.id} text={d.title}>
                      {d.title}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
              <FluentField
                label="Document id"
                required
                {...(id !== '' && !ok
                  ? {
                      validationState: 'error' as const,
                      validationMessage: 'A document id is a UUID as the document hub shows it.',
                    }
                  : { hint: 'The hub document that evidences the item (visible to you).' })}
              >
                <Input
                  className="pb-pipe-id"
                  value={documentId}
                  onChange={(_e, d) => setDocumentId(d.value)}
                />
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!ok}>
                Receive
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

type ItemPending = { kind: 'receive'; item: ClosingItem } | { kind: 'waive'; item: ClosingItem };

function ItemActions({
  item,
  roles,
  lock,
  busy,
  onStart,
  onReopen,
}: {
  item: ClosingItem;
  roles: readonly string[];
  /** Why the checklist takes no change (closingLock), or null while it does. */
  lock: string | null;
  busy: boolean;
  onStart: (pending: ItemPending) => void;
  onReopen: (item: ClosingItem) => void;
}): ReactNode {
  // The role first, as the API answers; then what operations confirmed stays as confirmed.
  const blocked =
    blockedTitle({
      allowed: mayUse(roles, PIPELINE_ROLES.closingItem),
      roles: PIPELINE_ROLES.closingItem,
    }) ?? lock;
  // A step back (Reopen) is drawn quiet, as it is on the valuation board, so the commands that move
  // the item on read first.
  const button = (
    label: string,
    onClick: () => void,
    appearance: 'outline' | 'subtle' = 'outline',
  ): ReactNode => (
    <Button
      size="small"
      appearance={appearance}
      disabled={blocked !== null || busy}
      {...(blocked === null ? {} : { title: blocked })}
      aria-label={`${label}, ${item.label}`}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <span className="pb-command-buttons">
      {item.status === 'open' ? (
        <>
          {button('Receive', () => onStart({ kind: 'receive', item }))}
          {button('Waive', () => onStart({ kind: 'waive', item }))}
        </>
      ) : (
        button('Reopen', () => onReopen(item), 'subtle')
      )}
    </span>
  );
}

function ItemsCard({
  closing,
  roles,
  log,
}: {
  closing: ClosingDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const command = useClosingItemCommand();
  const changed = useJustChanged();
  const [pending, setPending] = useState<ItemPending | null>(null);
  const { items: lock, move } = closingLock(closing);
  const issue = (item: ClosingItem, body: ClosingItemCommandBody): void => {
    command.mutate(
      { id: closing.id, itemCode: item.itemCode, body },
      {
        onSuccess: (updated) => {
          const now = updated.items.find((i) => i.itemCode === item.itemCode);
          changed.mark(item.itemCode);
          log.record(
            'good',
            `${item.label} is now ${humanizeState(now?.status ?? body.command)} ${resultSuffix()}`,
          );
        },
        onError: (error) =>
          log.record(
            'bad',
            `${humanizeState(body.command)} ${item.label}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const close = (): void => setPending(null);
  return (
    <Card testId="closing-items">
      <SectionHeader
        aside={`${plural(closing.itemsOpen, 'item')} open, ${closing.itemsRequiredOpen} required`}
      >
        Checklist
      </SectionHeader>
      {closing.items.length === 0 ? (
        <p className="pb-meta">No checklist items.</p>
      ) : (
        <TableWrap label="Closing checklist">
          <table className="pb-table" aria-label="Closing checklist">
            <thead>
              <tr>
                <th className="pb-col-text">Item</th>
                <th className="pb-col-fit">Required</th>
                <th className="pb-col-fit">Status</th>
                <th className="pb-col-fit">Document</th>
                <th className="pb-col-fit">Actions</th>
              </tr>
            </thead>
            <tbody>
              {closing.items.map((item) => (
                <tr
                  key={item.id}
                  data-testid={`closing-item-${item.itemCode}`}
                  {...changed.rowProps(item.itemCode)}
                >
                  <td className="pb-col-text">
                    {item.label}
                    {item.waivedReason === null ? null : (
                      <span className="pb-cell-sub">Waived: {item.waivedReason}</span>
                    )}
                  </td>
                  <td className="pb-col-fit">{item.required ? 'Required' : 'Optional'}</td>
                  <td className="pb-col-fit">
                    <Badge tone={itemStatusTone(item)}>{humanizeState(item.status)}</Badge>
                  </td>
                  <td className="pb-col-fit">
                    {item.documentId === null ? (
                      MISSING
                    ) : (
                      <Link to="/documents/$id" params={{ id: item.documentId }}>
                        Document
                      </Link>
                    )}
                  </td>
                  <td className="pb-col-fit">
                    <ItemActions
                      item={item}
                      roles={roles}
                      lock={lock}
                      busy={command.isPending}
                      onStart={setPending}
                      onReopen={(i) => issue(i, { command: 'reopen' })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {lock === null ? (
        <p className="pb-note">
          Operations cannot confirm the closing while a required item is open. Optional items are
          tracked but never block.
        </p>
      ) : lock === move ? null : (
        <p className="pb-note" data-testid="closing-items-lock">
          {lock}.
        </p>
      )}
      {pending?.kind === 'receive' ? (
        <ReceiveDialog
          item={pending.item}
          investmentId={closing.investmentId}
          onCancel={close}
          onSubmit={(documentId) => {
            issue(pending.item, { command: 'receive', documentId });
            close();
          }}
        />
      ) : null}
      {pending?.kind === 'waive' ? (
        <ReasonDialog
          title="Waive"
          subject={pending.item.label}
          onCancel={close}
          onSubmit={(reason) => {
            issue(pending.item, { command: 'waive', reason });
            close();
          }}
        />
      ) : null}
    </Card>
  );
}

function RecordCard({
  closing,
  roles,
  log,
}: {
  closing: ClosingDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const command = useClosingCommand();
  const [changing, setChanging] = useState(false);
  const [reopening, setReopening] = useState(false);
  const roleBlocked = blockedTitle({
    allowed: mayUse(roles, PIPELINE_ROLES.closingCommand),
    roles: PIPELINE_ROLES.closingCommand,
  });
  // Once the deal converted, the close date is the position's entry date: the record no longer moves.
  const moveLock = closingLock(closing).move;
  const moveBlocked = roleBlocked ?? moveLock;
  const blockers = closingBlockers(closing);
  const confirmBlocked = roleBlocked ?? (blockers.length === 0 ? null : blockers.join('; '));
  const confirm = (): void => {
    if (confirmBlocked !== null) return;
    command.mutate(
      { id: closing.id, body: { command: 'confirm' } },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `Closing confirmed for ${formatDate(updated.closeDate)}; the record is ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) => log.record('bad', `Confirm: ${describeActionError(error)}`),
      },
    );
  };
  const changeDate = (closeDate: string, reason: string): void => {
    command.mutate(
      { id: closing.id, body: { command: 'changeCloseDate', closeDate, reason } },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `Close date is now ${formatDate(updated.closeDate)}; the record is ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) => log.record('bad', `Change close date: ${describeActionError(error)}`),
      },
    );
  };
  const reopen = (reason: string): void => {
    command.mutate(
      { id: closing.id, body: { command: 'reopen', reason } },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `Closing reopened; the record is ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) => log.record('bad', `Reopen closing: ${describeActionError(error)}`),
      },
    );
  };
  const changeButton = (
    <Button
      appearance="secondary"
      disabled={moveBlocked !== null || command.isPending}
      {...(moveBlocked === null ? {} : { title: moveBlocked })}
      onClick={() => setChanging(true)}
    >
      Change close date
    </Button>
  );
  return (
    <Card testId="closing-record">
      <SectionHeader aside={<SimulatedBadge />}>Closing record</SectionHeader>
      <ActionStatus latest={log.latest} testId="closing-action-status" />
      <KeyValueTable
        label="Closing record"
        rows={[
          {
            label: 'Close date',
            value: (
              <span className="pb-nowrap" data-testid="closing-close-date">
                {formatDate(closing.closeDate)}
              </span>
            ),
          },
          { label: 'Commitment', value: formatMoneyM(closing.commitmentAmount) },
          {
            label: 'State',
            value: <Badge tone={closingTone(closing.state)}>{humanizeState(closing.state)}</Badge>,
          },
          { label: 'Currency', value: closing.currency },
          { label: 'Confirmed by', value: personName(closing.opsConfirmedBy) },
          {
            label: 'Confirmed at',
            value:
              closing.opsConfirmedAt === null ? MISSING : formatDateTime(closing.opsConfirmedAt),
          },
        ]}
      />
      <div className="pb-actions pb-pipe-gap">
        {closing.state === 'Open' ? (
          <Button
            appearance="primary"
            data-testid="closing-confirm"
            disabled={confirmBlocked !== null || command.isPending}
            {...(confirmBlocked === null ? {} : { title: confirmBlocked })}
            onClick={confirm}
          >
            Confirm closing
          </Button>
        ) : (
          <Button
            appearance="secondary"
            data-testid="closing-reopen"
            disabled={moveBlocked !== null || command.isPending}
            {...(moveBlocked === null ? {} : { title: moveBlocked })}
            onClick={() => setReopening(true)}
          >
            Reopen closing
          </Button>
        )}
        {changeButton}
      </div>
      {closing.state === 'Open' ? null : (
        <p className="pb-note">
          {moveLock === null
            ? 'Confirmed by operations: the checklist and the allocations stay as confirmed. A close date change or a reopen returns the record to Open and needs confirmation again.'
            : 'Confirmed by operations.'}
        </p>
      )}
      {closing.state === 'Open' && blockers.length > 0 ? (
        <ul className="pb-list pb-pipe-blockers" data-testid="closing-blockers">
          {blockers.map((b) => (
            <li key={b} className="pb-note">
              {b}
            </li>
          ))}
        </ul>
      ) : null}
      {closing.state === 'Open' && blockers.length === 0 ? (
        <p className="pb-note">
          Every required item is in and the received amounts tie out; operations may confirm.
        </p>
      ) : null}
      {changing ? (
        <CloseDateDialog
          closing={closing}
          onCancel={() => setChanging(false)}
          onSubmit={(closeDate, reason) => {
            changeDate(closeDate, reason);
            setChanging(false);
          }}
        />
      ) : null}
      {reopening ? (
        <ReasonDialog
          title="Reopen closing"
          subject={`Confirmed for ${formatDate(closing.closeDate)}. ${REOPEN_RULE}`}
          onCancel={() => setReopening(false)}
          onSubmit={(reason) => {
            reopen(reason);
            setReopening(false);
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * The tie-out (M22) as a ledger: the commitment, the received total (the allocated figure) and the
 * difference under a rule, every figure the API's, the same for every reader; the outcome in
 * words beside the title. The lines follow by vehicle, with the client breakdown as quiet
 * secondary detail and the count of lines the reader is not shown (AllocationLines.tsx).
 */
function TieOutCard({ closing }: { closing: ClosingDetail }): ReactNode {
  const t = closing.allocationTieOut;
  const { items: lock, move } = closingLock(closing);
  return (
    <Card testId="closing-tie-out">
      <SectionHeader aside={<Badge tone={tieOutTone(t)}>{tieOutLabel(t)}</Badge>}>
        Allocation tie-out
      </SectionHeader>
      <table className="pb-pipe-ledger" aria-label="Allocation tie-out">
        <tbody>
          <tr>
            <th scope="row">Commitment</th>
            <NumCell>{formatMoneyM(t.commitment)}</NumCell>
          </tr>
          <tr>
            <th scope="row">
              Allocated
              <span className="pb-cell-sub">Sum of the received amounts</span>
            </th>
            <NumCell>{formatMoneyM(t.allocated)}</NumCell>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Difference</th>
            <NumCell className={t.tiedOut ? 'is-good' : 'is-bad'}>
              {formatMoneyM(t.difference)}
            </NumCell>
          </tr>
        </tfoot>
      </table>
      {closing.allocations.length === 0 && t.hiddenLines === 0 ? (
        <EmptyState
          title="No allocation lines"
          detail="Allocations are edited on the opportunity page; the closing cannot complete until the received amounts equal the commitment."
        />
      ) : (
        <AllocationLinesTable rows={closing.allocations} hiddenLines={t.hiddenLines} />
      )}
      {lock === null ? (
        <p className="pb-note">
          <Link to="/pipeline/$id" params={{ id: closing.opportunityId }}>
            Edit the allocations on the opportunity page
          </Link>
          . The closing cannot complete until the received amounts equal the commitment.
        </p>
      ) : (
        <p className="pb-note">
          The lines stay as confirmed:{' '}
          <Link to="/pipeline/$id" params={{ id: closing.opportunityId }}>
            see them on the opportunity page
          </Link>
          .{lock === move ? null : ` ${lock}.`}
        </p>
      )}
    </Card>
  );
}

/** A legal term's fields one per line: the name in words ("Lock up months"), true and false as Yes and No. */
function TermValue({
  value,
}: {
  value: Readonly<Record<string, string | number | boolean>>;
}): ReactNode {
  const entries = Object.entries(value);
  if (entries.length === 0) return MISSING;
  return (
    <ul className="pb-pipe-term-lines">
      {entries.map(([key, v]) => (
        <li key={key}>
          {humanizeState(key)}: {v === true ? 'Yes' : v === false ? 'No' : String(v)}
        </li>
      ))}
    </ul>
  );
}

const EMPTY_FIELD: TermField = { name: '', value: '' };

function LegalTermForm({
  closing,
  roles,
  log,
}: {
  closing: ClosingDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const taxonomy = useQuery(taxonomyQuery);
  const create = useCreateLegalTerm();
  const [termType, setTermType] = useState('');
  const [fields, setFields] = useState<TermField[]>([{ ...EMPTY_FIELD }]);
  const [sourceDocumentId, setSourceDocumentId] = useState('');
  const types = termsOf(taxonomy.data, 'legal_term_type');
  const value = termValueOf(fields);
  const sourceId = sourceDocumentId.trim();
  const sourceOk = sourceId === '' || uuid.safeParse(sourceId).success;
  const ready = termType !== '' && Object.keys(value).length > 0 && sourceOk;
  const blocked = blockedTitle({
    allowed: mayUse(roles, PIPELINE_ROLES.legalTerm),
    roles: PIPELINE_ROLES.legalTerm,
  });
  const setField = (index: number, patch: Partial<TermField>): void =>
    setFields((fs) => fs.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  const submit = (): void => {
    if (!ready || blocked !== null) return;
    create.mutate(
      {
        id: closing.id,
        body: { termType, value, ...(sourceId === '' ? {} : { sourceDocumentId: sourceId }) },
      },
      {
        onSuccess: () => {
          log.record('good', `Legal term added in draft: ${labelOf(termType)} ${resultSuffix()}`);
          setTermType('');
          setFields([{ ...EMPTY_FIELD }]);
          setSourceDocumentId('');
        },
        onError: (error) => log.record('bad', `Add legal term: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <form
      noValidate
      className="pb-pipe-term-form"
      data-testid="legal-term-form"
      aria-label="Add a legal term"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <FluentField label="Term type" required>
        <Dropdown
          placeholder={types.length === 0 ? 'No term types loaded' : 'Choose a term type'}
          value={termType === '' ? '' : labelOf(termType)}
          selectedOptions={termType === '' ? [] : [termType]}
          onOptionSelect={(_e, d) => setTermType(d.optionValue ?? '')}
        >
          {types.map((t) => (
            <Option key={t.code} value={t.code} text={t.label}>
              {t.label}
            </Option>
          ))}
        </Dropdown>
      </FluentField>
      <FluentField
        label="Source document (optional)"
        {...(sourceOk
          ? { hint: 'The id of the hub document the term is read from.' }
          : {
              validationState: 'error' as const,
              validationMessage: 'A document id is a UUID as the document hub shows it.',
            })}
      >
        <Input
          className="pb-pipe-id"
          value={sourceDocumentId}
          onChange={(_e, d) => setSourceDocumentId(d.value)}
        />
      </FluentField>
      {fields.map((f, i) => (
        <Fragment key={i}>
          <Input
            aria-label={`Field name ${i + 1}`}
            placeholder="Field, such as rate"
            value={f.name}
            onChange={(_e, d) => setField(i, { name: d.value })}
          />
          <Input
            aria-label={`Field value ${i + 1}`}
            placeholder="Value, such as 2%"
            value={f.value}
            onChange={(_e, d) => setField(i, { value: d.value })}
          />
        </Fragment>
      ))}
      <div className="pb-actions pb-pipe-form-end">
        <Button
          appearance="secondary"
          onClick={() => setFields((fs) => [...fs, { ...EMPTY_FIELD }])}
        >
          Add field
        </Button>
        <Button
          appearance="secondary"
          type="submit"
          disabled={blocked !== null || !ready || create.isPending}
          {...(blocked === null ? {} : { title: blocked })}
        >
          Add term
        </Button>
      </div>
    </form>
  );
}

function LegalTermsCard({
  closing,
  roles,
  log,
}: {
  closing: ClosingDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const command = useLegalTermCommand();
  const blocked = blockedTitle({
    allowed: mayUse(roles, PIPELINE_ROLES.legalTermCommand),
    roles: PIPELINE_ROLES.legalTermCommand,
  });
  const confirm = (term: LegalTerm): void => {
    command.mutate(
      { id: closing.id, termId: term.id, body: { command: 'confirm' } },
      {
        onSuccess: () =>
          log.record('good', `${labelOf(term.termType)} confirmed ${resultSuffix()}`),
        onError: (error) =>
          log.record('bad', `Confirm ${labelOf(term.termType)}: ${describeActionError(error)}`),
      },
    );
  };
  return (
    <Card testId="legal-terms">
      <SectionHeader
        aside={
          closing.legalTerms.length === 0 ? undefined : plural(closing.legalTerms.length, 'term')
        }
      >
        Legal terms
      </SectionHeader>
      {closing.legalTerms.length === 0 ? (
        <EmptyState
          title="No legal terms captured"
          detail="Structured terms (fees, carry, key person, MFN, consents) are captured in draft and confirmed against their source document."
          testId="legal-terms-empty"
        />
      ) : (
        <TableWrap label="Legal terms">
          <table className="pb-table" aria-label="Legal terms">
            <thead>
              <tr>
                <th className="pb-col-fit">Term</th>
                <th className="pb-col-text">Value</th>
                <th className="pb-col-fit">Source</th>
                <th className="pb-col-fit">Status</th>
                <th className="pb-col-fit">Confirmed by</th>
                <th className="pb-col-fit">Actions</th>
              </tr>
            </thead>
            <tbody>
              {closing.legalTerms.map((t) => (
                <tr key={t.id} data-testid={`legal-term-${t.id}`}>
                  <td className="pb-col-fit">{labelOf(t.termType)}</td>
                  <td className="pb-col-text">
                    <TermValue value={t.value} />
                  </td>
                  <td className="pb-col-fit">
                    {t.sourceDocumentId === null ? (
                      MISSING
                    ) : (
                      <Link to="/documents/$id" params={{ id: t.sourceDocumentId }}>
                        Document
                      </Link>
                    )}
                  </td>
                  <td className="pb-col-fit">
                    <Badge tone={termStatusTone(t.status)}>{humanizeState(t.status)}</Badge>
                  </td>
                  <td className="pb-col-fit">{personName(t.confirmedBy)}</td>
                  <td className="pb-col-fit">
                    {t.status === 'draft' ? (
                      <Button
                        size="small"
                        appearance="outline"
                        disabled={blocked !== null || command.isPending}
                        {...(blocked === null ? {} : { title: blocked })}
                        aria-label={`Confirm, ${labelOf(t.termType)}`}
                        onClick={() => confirm(t)}
                      >
                        Confirm
                      </Button>
                    ) : (
                      <span className="pb-visually-hidden">No actions</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <LegalTermForm closing={closing} roles={roles} log={log} />
    </Card>
  );
}

function Panel({
  closing,
  roles,
}: {
  closing: ClosingDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  // Once the deal converted, every change to the closing is a deal change request: said once here,
  // and in the title of each command it stops.
  const { move } = closingLock(closing);
  return (
    <div className="pb-page-body" data-testid="closing-panel">
      {move === null ? null : <Notice testId="closing-position-note">{move}.</Notice>}
      <div className="pb-two-col">
        <RecordCard closing={closing} roles={roles} log={log} />
        <TieOutCard closing={closing} />
      </div>
      <ItemsCard closing={closing} roles={roles} log={log} />
      <LegalTermsCard closing={closing} roles={roles} log={log} />
      <ActionLogCard entries={log.entries} />
    </div>
  );
}

/**
 * The closing record (docs/04 M8, docs/18 section 12; M22): the close date every report reads,
 * the checklist, the operations confirmation with what blocks it in words, the allocation
 * tie-out on received amounts and the legal terms. While the closing is confirmed its checklist
 * and its lines take no change (operations reopen it with a reason first), and once the position
 * exists neither the close date change nor the reopen is offered: the reason is shown each time.
 * Used by the closing page and the deal workspace's Closing tab.
 */
export function ClosingPanel({
  closingId,
  roles,
}: {
  closingId: string;
  roles: readonly string[];
}): ReactNode {
  const q = useQuery(closingQuery(closingId));
  if (q.isPending) return <PageSkeleton tiles={3} rows={6} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return hidden ? (
      <ErrorState
        title="Closing not found or not visible to you"
        detail="There is no closing record with this id in your view. It may sit behind an information wall you are not on."
      />
    ) : (
      <UnavailableState
        card
        error={q.error}
        subject="This closing record"
        errorTitle="Closing record unavailable"
        testId="closing-unavailable"
      />
    );
  }
  return <Panel closing={q.data} roles={roles} />;
}
