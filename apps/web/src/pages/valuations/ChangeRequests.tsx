import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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
  Label,
  Option,
} from '@fluentui/react-components';
import type {
  ChangeRequestCommand,
  ChangeRequestCommandBody,
  ChangeRequestPage,
  ChangeRequestRow,
  ChangeRequestState,
  MockUser,
  QuarterEndCheckResult,
} from '@pb/contracts';
import { dealChangeRequestMachine } from '@pb/workflows';
import { previewMode } from '../../app/env.js';
import { describeActionError } from '../../app/mutations.js';
import { VALUATION_TABS } from '../../app/nav.js';
import { LIST_LIMIT, meQuery, mockUsersQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  CountTile,
  EmptyState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import {
  ActionLogCard,
  ActionStatus,
  CommandButtons,
  ReasonDialog,
} from '../../components/WorkflowActions.js';
import { formatDate, labelOf, MISSING, plural } from '../../lib/format.js';
import {
  changeRequestTone,
  commandLabel,
  commandOptions,
  humanizeState,
  rolesLabel,
} from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { blockedTitle, resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { useChangeRequestCommand, useQuarterEndCheck, changeRequestsQuery } from './api.js';
import {
  applicablePeriods,
  canRunQuarterEndCheck,
  CHANGE_REQUEST_STATES,
  filterRequests,
  investmentOptions,
  isChangeRequestState,
  ownerCandidates,
  QUARTER_END_CHECK_ROLES,
  QUEUE_ROLES,
  recentQuarterEnds,
  requestCounts,
  requestLabel,
} from './changes.js';
import type { NamedOption } from './changes.js';
import './valuations.css';

type RequestOption = CommandOption<ChangeRequestState, ChangeRequestCommand>;

const META =
  'Changes to a position, routed to operations and applied in a quarter (docs/18 section 8)';

/** What a role the queue refuses is told (the API answers 403). */
const FORBIDDEN = {
  title: 'Change requests are for the deal team, operations, approvers and auditors',
  detail: `The queue is read by ${rolesLabel(QUEUE_ROLES)}. Ask a platform administrator if you need access.`,
};

/** How many recent quarter ends the check offers. */
const QUARTER_ENDS_OFFERED = 12;

/** Today as an ISO date, the day the quarter-end pickers count back from. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function PeriodDialog({
  title,
  subject,
  hint,
  periods,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  subject: string;
  hint: string;
  periods: readonly string[];
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (periodEnd: string) => void;
}): ReactNode {
  const [period, setPeriod] = useState(periods[0] ?? '');
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (period !== '') onSubmit(period);
          }}
        >
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <FluentField label="Quarter end" required hint={hint}>
                <Dropdown
                  value={period === '' ? '' : formatDate(period)}
                  selectedOptions={period === '' ? [] : [period]}
                  onOptionSelect={(_e, d) => setPeriod(d.optionValue ?? '')}
                >
                  {periods.map((p) => (
                    <Option key={p} value={p} text={formatDate(p)}>
                      {formatDate(p)}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={period === ''}>
                {submitLabel}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

function RouteDialog({
  subject,
  owners,
  onCancel,
  onSubmit,
}: {
  subject: string;
  owners: readonly NamedOption[];
  onCancel: () => void;
  onSubmit: (ownerId: string) => void;
}): ReactNode {
  const [ownerId, setOwnerId] = useState('');
  const owner = owners.find((o) => o.id === ownerId);
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (owner !== undefined) onSubmit(owner.id);
          }}
        >
          <DialogBody>
            <DialogTitle>Route</DialogTitle>
            <DialogContent className="pb-dialog-content">
              <p className="pb-meta">{subject}</p>
              <FluentField
                label="Owner"
                required
                hint="An operations user who will apply the change in a quarter or reject it."
                {...(owners.length === 0
                  ? {
                      validationState: 'error' as const,
                      validationMessage: 'No operations user is available to route to.',
                    }
                  : {})}
              >
                <Dropdown
                  placeholder="Choose an owner"
                  value={owner?.name ?? ''}
                  selectedOptions={ownerId === '' ? [] : [ownerId]}
                  disabled={owners.length === 0}
                  onOptionSelect={(_e, d) => setOwnerId(d.optionValue ?? '')}
                >
                  {owners.map((o) => (
                    <Option key={o.id} value={o.id} text={o.name}>
                      {o.name}
                    </Option>
                  ))}
                </Dropdown>
              </FluentField>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={owner === undefined}>
                Route
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

function QueueTable({
  rows,
  roles,
  busy,
  onIssue,
}: {
  rows: readonly ChangeRequestRow[];
  roles: readonly string[];
  busy: boolean;
  onIssue: (row: ChangeRequestRow, option: RequestOption) => void;
}): ReactNode {
  return (
    <TableWrap label="Change requests">
      <table
        className="pb-table pb-val-table"
        aria-label="Change requests"
        data-testid="change-requests-table"
      >
        <thead>
          <tr>
            <th>Position</th>
            <th>Change</th>
            <th>Summary</th>
            <th>Owner</th>
            <th>Submitted</th>
            <th>State</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="pb-val-position">
                <Link to="/portfolio/$id" params={{ id: r.investmentId }}>
                  {r.investmentName}
                </Link>
              </td>
              <td className="pb-val-period">
                <span>{labelOf(r.changeType)}</span>
                <span className="pb-cell-sub">
                  <span>Effective {formatDate(r.effectiveDate)}</span>
                </span>
              </td>
              <td>{r.summary}</td>
              <td>{r.owner?.name ?? MISSING}</td>
              <td className="pb-val-period">
                <span>{r.submittedBy.name}</span>
                <span className="pb-cell-sub">
                  <span>{formatDate(r.createdAt.slice(0, 10))}</span>
                </span>
              </td>
              <td className="pb-val-state">
                <Badge tone={changeRequestTone(r.state)}>{humanizeState(r.state)}</Badge>
                {r.appliedPeriod === null ? null : (
                  <span className="pb-cell-sub">
                    Applied in <span>{formatDate(r.appliedPeriod)}</span>
                  </span>
                )}
                {r.rejectionReason === null ? null : (
                  <span className="pb-cell-sub">
                    <span>{r.rejectionReason}</span>
                  </span>
                )}
              </td>
              <td data-testid="change-request-actions">
                <CommandButtons
                  options={commandOptions(dealChangeRequestMachine, r.state, roles)}
                  busy={busy}
                  appearance="outline"
                  context={requestLabel(r)}
                  onIssue={(option) => onIssue(r, option)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * The quarter-end check (M11): every request not Applied by the quarter end, each opening a data
 * exception so it appears on the exceptions list. Operations runs it; the answer stays on the
 * page until the next run.
 */
function QuarterEndCard({ roles, log }: { roles: readonly string[]; log: ActionLog }): ReactNode {
  const check = useQuarterEndCheck();
  const periods = recentQuarterEnds(todayIso(), QUARTER_ENDS_OFFERED);
  const [period, setPeriod] = useState(periods[0] ?? '');
  const [result, setResult] = useState<QuarterEndCheckResult | null>(null);
  const blocked = blockedTitle({
    allowed: canRunQuarterEndCheck(roles),
    roles: QUARTER_END_CHECK_ROLES,
  });
  const run = (): void => {
    check.mutate(
      { periodEnd: period },
      {
        onSuccess: (answer) => {
          setResult(answer);
          log.record(
            'good',
            `Quarter-end check for ${formatDate(answer.periodEnd)}: ${plural(answer.unapplied.length, 'request')} not applied, ${plural(answer.exceptionsOpened, 'data exception')} opened ${resultSuffix()}`,
          );
        },
        onError: (error) =>
          log.record(
            'bad',
            `Quarter-end check for ${formatDate(period)}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  return (
    <Card testId="quarter-end-check">
      <SectionHeader aside={previewMode ? <SimulatedBadge /> : undefined}>
        Quarter-end check
      </SectionHeader>
      <p className="pb-meta">
        Lists every request not applied by the quarter end and opens a data exception for each one
        still missing from the exceptions list (docs/04 M11). Running it again opens nothing more.
      </p>
      <Toolbar
        end={
          <Button
            size="small"
            appearance="primary"
            disabled={blocked !== null || check.isPending || period === ''}
            {...(blocked === null ? {} : { title: blocked })}
            onClick={run}
          >
            Run quarter-end check
          </Button>
        }
      >
        <Field>
          <Label htmlFor="quarter-end-period">Quarter end</Label>
          <Dropdown
            id="quarter-end-period"
            className="pb-val-filter"
            value={period === '' ? '' : formatDate(period)}
            selectedOptions={period === '' ? [] : [period]}
            onOptionSelect={(_e, d) => setPeriod(d.optionValue ?? '')}
          >
            {periods.map((p) => (
              <Option key={p} value={p} text={formatDate(p)}>
                {formatDate(p)}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Toolbar>
      {result === null ? null : (
        <div data-testid="quarter-end-result">
          <p className="pb-notice">
            {formatDate(result.periodEnd)}: {plural(result.unapplied.length, 'request')} not
            applied, {plural(result.exceptionsOpened, 'data exception')} opened.{' '}
            <Link to="/data/exceptions" search={{}}>
              Open the exceptions queue
            </Link>
          </p>
          {result.unapplied.length === 0 ? (
            <EmptyState
              title="Every request is applied"
              detail={`No change request with an effective date on or before ${formatDate(result.periodEnd)} is still open.`}
            />
          ) : (
            <TableWrap label="Unapplied change requests">
              <table className="pb-table" aria-label="Unapplied change requests">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Change</th>
                    <th>Effective</th>
                    <th>Owner</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {result.unapplied.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to="/portfolio/$id" params={{ id: r.investmentId }}>
                          {r.investmentName}
                        </Link>
                      </td>
                      <td>{labelOf(r.changeType)}</td>
                      <td className="pb-nowrap">{formatDate(r.effectiveDate)}</td>
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
        </div>
      )}
    </Card>
  );
}

type Pending =
  | { kind: 'route'; row: ChangeRequestRow }
  | { kind: 'apply'; row: ChangeRequestRow }
  | { kind: 'reject'; row: ChangeRequestRow };

function Queue({
  page,
  roles,
  users,
}: {
  page: ChangeRequestPage;
  roles: readonly string[];
  users: readonly MockUser[] | undefined;
}): ReactNode {
  const [stateFilter, setStateFilter] = useState<ChangeRequestState | ''>('');
  const [investmentId, setInvestmentId] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const log = useActionLog();
  const command = useChangeRequestCommand();
  const counts = requestCounts(page.items);
  const partial = page.nextCursor !== null;
  const rows = filterRequests(page.items, { state: stateFilter, investmentId });
  const positions = investmentOptions(page.items);
  const position = positions.find((p) => p.id === investmentId);
  const owners = ownerCandidates(users, page.items);
  const issue = (row: ChangeRequestRow, body: ChangeRequestCommandBody): void => {
    command.mutate(
      { id: row.id, body },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `${requestLabel(updated)} is now ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) =>
          log.record(
            'bad',
            `${commandLabel(body.command)} for ${requestLabel(row)}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const start = (row: ChangeRequestRow, option: RequestOption): void => {
    switch (option.command) {
      case 'route':
        setPending({ kind: 'route', row });
        break;
      case 'apply':
        setPending({ kind: 'apply', row });
        break;
      case 'reject':
        setPending({ kind: 'reject', row });
        break;
      case 'start':
        issue(row, { command: 'start' });
        break;
    }
  };
  const narrowed = stateFilter !== '' || investmentId !== '';
  return (
    <>
      <PageHeader title="Change requests" meta={META} />
      <TabNav label="Valuations" items={VALUATION_TABS} />
      <div ref={balanceTiles} className="pb-tiles" data-testid="change-request-tiles">
        <CountTile
          label="Submitted"
          count={counts.submitted}
          hint="Waiting for the deal team to route"
          tone={counts.submitted > 0 ? 'watch' : undefined}
          partial={partial}
        />
        <CountTile
          label="Routed"
          count={counts.routed}
          hint="With an operations owner"
          partial={partial}
        />
        <CountTile
          label="In progress"
          count={counts.inProgress}
          hint="Being applied by operations"
          partial={partial}
        />
        <CountTile
          label="Applied"
          count={counts.applied}
          hint="Applied in a quarter"
          partial={partial}
        />
      </div>
      <Card testId="change-requests-card">
        <SectionHeader
          aside={
            <>
              {`${rows.length} of ${plural(page.items.length, 'request')}`}
              <SimulatedBadge />
            </>
          }
        >
          Queue
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="change-request-state">State</Label>
            <Dropdown
              id="change-request-state"
              className="pb-val-filter"
              value={stateFilter === '' ? 'All states' : humanizeState(stateFilter)}
              selectedOptions={[stateFilter]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setStateFilter(isChangeRequestState(v) ? v : '');
              }}
            >
              <Option value="">All states</Option>
              {CHANGE_REQUEST_STATES.map((s) => (
                <Option key={s} value={s}>
                  {humanizeState(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="change-request-position">Position</Label>
            <Dropdown
              id="change-request-position"
              className="pb-val-filter is-wide"
              value={position?.name ?? 'All positions'}
              selectedOptions={[investmentId]}
              onOptionSelect={(_e, d) => setInvestmentId(d.optionValue ?? '')}
            >
              <Option value="">All positions</Option>
              {positions.map((p) => (
                <Option key={p.id} value={p.id} text={p.name}>
                  {p.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        <ActionStatus latest={log.latest} testId="change-request-action-status" />
        {rows.length === 0 ? (
          <EmptyState
            title={narrowed ? 'No requests match these filters' : 'No change requests'}
            detail={
              narrowed
                ? 'Pick another state or position.'
                : 'The deal team submits a request from the Valuations tab of a position; it appears here for routing.'
            }
            testId="change-requests-empty"
          />
        ) : (
          <QueueTable rows={rows} roles={roles} busy={command.isPending} onIssue={start} />
        )}
        {partial ? (
          <p className="pb-meta" data-testid="change-requests-truncated">
            Showing the first {LIST_LIMIT} change requests; more exist.
          </p>
        ) : null}
      </Card>
      <div className="pb-two-col">
        <QuarterEndCard roles={roles} log={log} />
        <ActionLogCard entries={log.entries} />
      </div>
      {pending?.kind === 'route' ? (
        <RouteDialog
          subject={requestLabel(pending.row)}
          owners={owners}
          onCancel={() => setPending(null)}
          onSubmit={(ownerId) => {
            issue(pending.row, { command: 'route', ownerId });
            setPending(null);
          }}
        />
      ) : null}
      {pending?.kind === 'apply' ? (
        <PeriodDialog
          title="Apply"
          subject={requestLabel(pending.row)}
          hint={`The quarter the change is applied in: a quarter end on or after the effective date, ${formatDate(pending.row.effectiveDate)}.`}
          periods={applicablePeriods(pending.row.effectiveDate, todayIso())}
          submitLabel="Apply"
          onCancel={() => setPending(null)}
          onSubmit={(appliedPeriod) => {
            issue(pending.row, { command: 'apply', appliedPeriod });
            setPending(null);
          }}
        />
      ) : null}
      {pending?.kind === 'reject' ? (
        <ReasonDialog
          title="Reject"
          subject={requestLabel(pending.row)}
          onCancel={() => setPending(null)}
          onSubmit={(reason) => {
            issue(pending.row, { command: 'reject', reason });
            setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The deal change request queue (docs/04 M11, docs/18 section 8): every request on the positions
 * the caller can see, with the commands the signed-in roles may issue (route with an owner, start,
 * apply in a quarter, reject with a reason) and the quarter-end check for operations.
 */
export function ChangeRequestsPage(): ReactNode {
  const me = useQuery(meQuery);
  const list = useQuery({ ...changeRequestsQuery({}), placeholderData: keepPreviousData });
  // The owner picker names the operations users of the mock list, which exists only with the mock identity.
  const users = useQuery({ ...mockUsersQuery, enabled: me.data?.mockIdentity === true });
  if (list.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (list.isError) {
    return (
      <>
        <PageHeader title="Change requests" meta={META} />
        <TabNav label="Valuations" items={VALUATION_TABS} />
        <UnavailableState
          card
          error={list.error}
          subject="Change requests"
          forbidden={FORBIDDEN}
          errorTitle="Change requests unavailable"
          testId="change-requests-unavailable"
        />
      </>
    );
  }
  return <Queue page={list.data} roles={me.data?.roles ?? []} users={users.data?.users} />;
}
