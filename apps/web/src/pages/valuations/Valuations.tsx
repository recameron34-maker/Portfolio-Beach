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
  Input,
  Label,
  Option,
  Spinner,
} from '@fluentui/react-components';
import { Add16Regular, Search16Regular } from '@fluentui/react-icons';
import type {
  InvestmentPage,
  InvestmentSummary,
  ValuationCommand,
  ValuationPage,
  ValuationRow,
  ValuationState,
} from '@pb/contracts';
import { valuationMachine } from '@pb/workflows';
import { previewMode } from '../../app/env.js';
import {
  describeActionError,
  useCreateValuation,
  usePreviewReset,
  useValuationCommand,
} from '../../app/mutations.js';
import type { ValuationCreateBody } from '../../app/mutations.js';
import {
  investmentsQuery,
  LIST_LIMIT,
  meQuery,
  valuationsQuery,
  vehiclesQuery,
} from '../../app/queries.js';
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
  SimulatedBadge,
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, formatPct, labelOf, MISSING } from '../../lib/format.js';
import { commandLabel, commandOptions, humanizeState, valuationTone } from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import {
  aboveVarianceFlag,
  ACTIVE_POSITIONS,
  approvedOn,
  filterRows,
  isValuationState,
  lastMethodOf,
  latestFirst,
  methodCodes,
  missingMarks,
  periodCounts,
  VALUATION_STATES,
  VARIANCE_TITLE,
  vehicleNames,
  versionLabel,
} from './board.js';
import { NewValuationDialog } from './NewValuation.js';
import {
  ActionLogCard,
  ActionStatus,
  CommandButtons,
  ReasonDialog,
} from '../../components/WorkflowActions.js';
import { blockedTitle, resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import './valuations.css';

type ValuationOption = CommandOption<ValuationState, ValuationCommand>;

const GATE =
  'Reports read Locked valuations only. Draft, Ops prepared and Deal team approved versions never reach a report.';

function Gate(): ReactNode {
  return (
    <div className="pb-val-gates">
      <p className="pb-notice" data-testid="valuation-gate">
        {GATE}
      </p>
      {previewMode ? (
        <p className="pb-meta">
          Simulated changes do not recalculate NAV, MOIC or IRR; portfolio figures stay as recorded.
        </p>
      ) : null}
    </div>
  );
}

function ChangeCell({ changePct }: { changePct: string | null }): ReactNode {
  const text = formatPct(changePct);
  if (!aboveVarianceFlag(changePct)) return <NumCell>{text}</NumCell>;
  return (
    <td className="num">
      <span className="pb-val-change">
        <span title={VARIANCE_TITLE}>
          <Badge tone="watch">Variance</Badge>
        </span>
        {text}
      </span>
    </td>
  );
}

function VersionTable({
  rows,
  roles,
  busy,
  onIssue,
}: {
  rows: readonly ValuationRow[];
  roles: readonly string[];
  busy: boolean;
  onIssue: (row: ValuationRow, option: ValuationOption) => void;
}): ReactNode {
  return (
    <TableWrap label="Valuations">
      <table className="pb-table pb-val-table" aria-label="Valuations">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company</th>
            <th>Vehicle</th>
            <th>Deal type</th>
            <th>Period</th>
            <th>Version</th>
            <th>State</th>
            <th>Method</th>
            <th className="num">Prior fair value</th>
            <th className="num">Fair value</th>
            <th className="num">Change</th>
            <th>Approved</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <span className="pb-key">{row.investmentNumber}</span>
              </td>
              <td className="pb-val-name">
                <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
                  {row.companyName}
                </Link>
              </td>
              <td className="pb-val-name">{row.vehicleName}</td>
              <td className="pb-val-wrap">{labelOf(row.dealType)}</td>
              <td>{formatDate(row.periodEnd)}</td>
              <td>v{row.version}</td>
              <td>
                <Badge tone={valuationTone(row.state)}>{humanizeState(row.state)}</Badge>
              </td>
              <td className="pb-val-wrap">{labelOf(row.method)}</td>
              <NumCell>{formatMoneyM(row.priorFairValue)}</NumCell>
              <NumCell>{formatMoneyM(row.fairValue)}</NumCell>
              <ChangeCell changePct={row.changePct} />
              <td className={row.approvedAt === null ? 'is-missing' : undefined}>
                {approvedOn(row.approvedAt)}
              </td>
              <td>
                <CommandButtons
                  options={commandOptions(valuationMachine, row.state, roles)}
                  busy={busy}
                  appearance="outline"
                  context={versionLabel(row)}
                  onIssue={(option) => onIssue(row, option)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

type MarksStatus =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'truncated' }
  | { kind: 'ready'; missing: InvestmentSummary[] };

/** Missing marks need every valuation row and every active position; a partial page would invent gaps. */
function marksStatus(
  active: { data: InvestmentPage | undefined; error: unknown; isError: boolean },
  page: ValuationPage,
  period: string,
): MarksStatus {
  if (active.data === undefined) {
    return active.isError ? { kind: 'error', error: active.error } : { kind: 'loading' };
  }
  if (active.data.nextCursor !== null || page.nextCursor !== null) return { kind: 'truncated' };
  return { kind: 'ready', missing: missingMarks(active.data.items, page.items, period) };
}

function marksTile(status: MarksStatus, period: string): ReactNode {
  switch (status.kind) {
    case 'loading':
      return <StatTile label="Missing marks" value={MISSING} hint="Loading active positions" />;
    case 'error':
      return (
        <StatTile label="Missing marks" value={MISSING} hint="Active positions could not load" />
      );
    case 'truncated':
      return (
        <StatTile
          label="Missing marks"
          value={MISSING}
          hint="Not calculable: more rows than one page holds"
        />
      );
    case 'ready':
      return (
        <StatTile
          label="Missing marks"
          value={String(status.missing.length)}
          hint={`Active positions with no version for ${formatDate(period)}`}
          tone={status.missing.length > 0 ? 'watch' : undefined}
        />
      );
  }
}

function MissingMarksCard({
  status,
  period,
  canStart,
  onStart,
}: {
  status: MarksStatus;
  period: string;
  canStart: boolean;
  onStart: (investmentId: string) => void;
}): ReactNode {
  let body: ReactNode;
  switch (status.kind) {
    case 'loading':
      body = <Spinner size="tiny" label="Loading active positions" />;
      break;
    case 'error':
      body = <UnavailableState inline error={status.error} subject="Active positions" />;
      break;
    case 'truncated':
      body = (
        <EmptyState
          title="Missing marks need the full lists"
          detail={`More than ${LIST_LIMIT} valuation versions or active positions are visible, so a position could have a version beyond the first page. The list is not shown rather than guessed.`}
        />
      );
      break;
    case 'ready':
      body =
        status.missing.length === 0 ? (
          <EmptyState
            title="Every active position has a mark for this period"
            detail={`Each active position has at least one valuation version for ${formatDate(period)}.`}
          />
        ) : (
          <TableWrap label="Missing marks">
            <table className="pb-table" aria-label="Missing marks">
              <thead>
                <tr>
                  <th>Inv #</th>
                  <th>Company</th>
                  <th>Vehicle</th>
                  {canStart ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {status.missing.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="pb-key">{p.investmentNumber}</span>
                    </td>
                    <td>
                      <Link to="/portfolio/$id" params={{ id: p.id }}>
                        {p.companyName}
                      </Link>
                    </td>
                    <td>{p.vehicleName}</td>
                    {canStart ? (
                      <td>
                        <Button
                          size="small"
                          appearance="outline"
                          aria-label={`Start valuation, ${p.companyName}`}
                          onClick={() => onStart(p.id)}
                        >
                          Start valuation
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        );
      break;
  }
  return (
    <Card testId="missing-marks">
      <SectionHeader aside={formatDate(period)}>Missing marks</SectionHeader>
      {body}
    </Card>
  );
}

function ResetPreviewDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Reset preview</DialogTitle>
          <DialogContent className="pb-dialog-content">
            <p>Forget every simulated change in this page session?</p>
            <p className="pb-meta">
              The board returns to the recorded synthetic data. Nothing was saved or audited.
            </p>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={onConfirm}>
              Forget changes
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface Pending {
  row: ValuationRow;
  option: ValuationOption;
}

interface BoardActions {
  issue: (row: ValuationRow, option: ValuationOption, reason?: string) => void;
  createDraft: (body: ValuationCreateBody, position: InvestmentSummary) => void;
  resetPreview: () => void;
  busy: boolean;
}

/** Commands, the new valuation form and the preview reset, each reporting into one action log. */
function useBoardActions(log: ActionLog): BoardActions {
  const command = useValuationCommand();
  const create = useCreateValuation();
  const reset = usePreviewReset();
  const issue = (row: ValuationRow, option: ValuationOption, reason?: string): void => {
    command.mutate(
      {
        id: row.id,
        body:
          reason === undefined ? { command: option.command } : { command: option.command, reason },
      },
      {
        onSuccess: (updated) =>
          log.record(
            'good',
            `${versionLabel(updated)} is now ${humanizeState(updated.state)} ${resultSuffix()}`,
          ),
        onError: (error) =>
          log.record(
            'bad',
            `${commandLabel(option.command)} for ${versionLabel(row)}: ${describeActionError(error)}`,
          ),
      },
    );
  };
  const createDraft = (body: ValuationCreateBody, position: InvestmentSummary): void => {
    create.mutate(body, {
      onSuccess: (created) =>
        log.record(
          'good',
          `Draft valuation created for ${created.companyName}, ${formatDate(created.periodEnd)} ${resultSuffix()}`,
        ),
      onError: (error) =>
        log.record(
          'bad',
          `New valuation for ${position.companyName}, ${formatDate(body.periodEnd)}: ${describeActionError(error)}`,
        ),
    });
  };
  const resetPreview = (): void => {
    reset.mutate(undefined, {
      onSuccess: () =>
        log.record(
          'good',
          'Preview reset. Every simulated change in this page session is forgotten.',
        ),
      onError: (error) => log.record('bad', `Reset preview: ${describeActionError(error)}`),
    });
  };
  return {
    issue,
    createDraft,
    resetPreview,
    busy: command.isPending || create.isPending || reset.isPending,
  };
}

function Board({ page, roles }: { page: ValuationPage; roles: readonly string[] }): ReactNode {
  const active = useQuery({
    ...investmentsQuery(ACTIVE_POSITIONS),
    placeholderData: keepPreviousData,
    retry: retryUnlessUnavailable,
  });
  const vehicles = useQuery({
    ...vehiclesQuery,
    placeholderData: keepPreviousData,
    retry: retryUnlessUnavailable,
  });
  const [periodChoice, setPeriodChoice] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ValuationState | ''>('');
  const [vehicle, setVehicle] = useState('');
  const [search, setSearch] = useState('');
  const [reasonFor, setReasonFor] = useState<Pending | null>(null);
  const [newFor, setNewFor] = useState<{ investmentId: string | null } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const log = useActionLog();
  const actions = useBoardActions(log);

  const isOps = roles.includes('operations');
  const periods = latestFirst([...page.periods, ...page.items.map((r) => r.periodEnd)]);
  const period =
    periodChoice !== null && periods.includes(periodChoice) ? periodChoice : periods[0];
  const positions = active.data?.items ?? [];
  const newBlocked = blockedTitle({ allowed: isOps, roles: ['operations'] });
  const newTitle =
    newBlocked ?? (positions.length === 0 ? 'No active positions loaded' : undefined);

  const header = (
    <PageHeader
      title="Valuations"
      meta={`As of ${formatDate(page.asOf)}. Reports read Locked valuations only.`}
      actions={
        isOps || previewMode ? (
          <>
            {isOps ? (
              <Button
                size="small"
                appearance="primary"
                icon={<Add16Regular />}
                disabled={newTitle !== undefined || period === undefined || actions.busy}
                {...(newTitle === undefined ? {} : { title: newTitle })}
                onClick={() => setNewFor({ investmentId: null })}
              >
                New valuation
              </Button>
            ) : null}
            {previewMode ? (
              <span className="pb-val-reset">
                <Button
                  size="small"
                  appearance="secondary"
                  disabled={actions.busy}
                  onClick={() => setConfirmReset(true)}
                >
                  Reset preview
                </Button>
                <SimulatedBadge />
              </span>
            ) : null}
          </>
        ) : undefined
      }
    />
  );

  if (period === undefined) {
    return (
      <>
        {header}
        <Gate />
        <Card>
          <EmptyState
            title="No valuations yet"
            detail="Valuation versions appear here once operations starts a Draft for a position and period."
          />
        </Card>
      </>
    );
  }

  const counts = periodCounts(page.items, period);
  const forPeriod = page.items.filter((r) => r.periodEnd === period).length;
  const rows = filterRows(page.items, { period, state: stateFilter, vehicle, search });
  const marks = marksStatus(active, page, period);
  const names = vehicleNames(vehicles.data?.items, page.items);
  const start = (row: ValuationRow, option: ValuationOption): void => {
    if (option.needsReason) setReasonFor({ row, option });
    else actions.issue(row, option);
  };

  return (
    <>
      {header}
      <Gate />
      <div className="pb-tiles" data-testid="valuation-tiles">
        <StatTile label="Locked" value={String(counts.locked)} hint="Read by reports" />
        <StatTile
          label="In flight"
          value={String(counts.inFlight)}
          hint="Draft, Ops prepared or Deal team approved"
        />
        <StatTile label="Reopened" value={String(counts.reopened)} hint="Reopened after Locked" />
        {marksTile(marks, period)}
      </div>
      <Card testId="valuation-board">
        <SectionHeader
          aside={
            <>
              {`${rows.length} of ${forPeriod} versions for ${formatDate(period)}`}
              <SimulatedBadge />
            </>
          }
        >
          Versions
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="valuation-period">Period</Label>
            <Dropdown
              id="valuation-period"
              className="pb-val-filter"
              value={formatDate(period)}
              selectedOptions={[period]}
              onOptionSelect={(_e, d) => {
                if (d.optionValue !== undefined) setPeriodChoice(d.optionValue);
              }}
            >
              {periods.map((p) => (
                <Option key={p} value={p}>
                  {formatDate(p)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="valuation-state">State</Label>
            <Dropdown
              id="valuation-state"
              className="pb-val-filter"
              value={stateFilter === '' ? 'All states' : humanizeState(stateFilter)}
              selectedOptions={[stateFilter]}
              onOptionSelect={(_e, d) => {
                const v = d.optionValue ?? '';
                setStateFilter(isValuationState(v) ? v : '');
              }}
            >
              <Option value="">All states</Option>
              {VALUATION_STATES.map((s) => (
                <Option key={s} value={s}>
                  {humanizeState(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="valuation-vehicle">Vehicle</Label>
            <Dropdown
              id="valuation-vehicle"
              className="pb-val-filter is-wide"
              value={vehicle === '' ? 'All vehicles' : vehicle}
              selectedOptions={[vehicle]}
              onOptionSelect={(_e, d) => setVehicle(d.optionValue ?? '')}
            >
              <Option value="">All vehicles</Option>
              {names.map((n) => (
                <Option key={n} value={n}>
                  {n}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="valuation-search">Search</Label>
            <Input
              id="valuation-search"
              className="pb-val-filter"
              contentBefore={<Search16Regular />}
              placeholder="Inv # or company"
              value={search}
              onChange={(_e, d) => setSearch(d.value)}
            />
          </Field>
        </Toolbar>
        <ActionStatus latest={log.latest} testId="valuation-action-status" />
        {rows.length === 0 ? (
          <EmptyState
            title={
              forPeriod === 0 ? 'No versions for this period' : 'No versions match these filters'
            }
            detail={
              forPeriod === 0
                ? 'Pick another period, or start a valuation from the missing marks below.'
                : 'Clear the search, or pick another state or vehicle.'
            }
          />
        ) : (
          <VersionTable rows={rows} roles={roles} busy={actions.busy} onIssue={start} />
        )}
        {page.nextCursor !== null ? (
          <p className="pb-meta" data-testid="valuations-truncated">
            Showing the first {LIST_LIMIT} valuation versions; more exist.
          </p>
        ) : null}
        {previewMode ? null : (
          <p className="pb-meta">
            Workflow actions arrive with Phase 3. This build reads only, so every action is shown
            but disabled.
          </p>
        )}
      </Card>
      <div className="pb-two-col">
        <MissingMarksCard
          status={marks}
          period={period}
          canStart={previewMode && isOps}
          onStart={(investmentId) => setNewFor({ investmentId })}
        />
        <ActionLogCard entries={log.entries} />
      </div>
      {reasonFor !== null ? (
        <ReasonDialog
          title={commandLabel(reasonFor.option.command)}
          subject={versionLabel(reasonFor.row)}
          onCancel={() => setReasonFor(null)}
          onSubmit={(reason) => {
            actions.issue(reasonFor.row, reasonFor.option, reason);
            setReasonFor(null);
          }}
        />
      ) : null}
      {newFor !== null ? (
        <NewValuationDialog
          positions={positions}
          period={period}
          methods={methodCodes(page.items)}
          methodFor={(id) => lastMethodOf(page.items, id)}
          initialInvestmentId={newFor.investmentId}
          onCancel={() => setNewFor(null)}
          onSubmit={(body, position) => {
            actions.createDraft(body, position);
            setNewFor(null);
          }}
        />
      ) : null}
      {confirmReset ? (
        <ResetPreviewDialog
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            actions.resetPreview();
            setConfirmReset(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The valuation batch screen (docs/04 M10, docs/18 section 1): every version for a period with its
 * state, the change against the prior Locked mark and the commands the signed-in roles may issue.
 */
export function ValuationsPage(): ReactNode {
  const me = useQuery(meQuery);
  const board = useQuery({ ...valuationsQuery({}), placeholderData: keepPreviousData });
  if (board.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (board.isError) {
    return (
      <>
        <PageHeader title="Valuations" meta="Reports read Locked valuations only." />
        <Gate />
        <UnavailableState
          card
          error={board.error}
          subject="The valuation board"
          errorTitle="Valuation board unavailable"
          testId="valuations-unavailable"
        />
      </>
    );
  }
  return <Board page={board.data} roles={me.data?.roles ?? []} />;
}
