import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
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
  ValuationBatchCommand,
  ValuationCommand,
  ValuationPage,
  ValuationRow,
  ValuationState,
} from '@pb/contracts';
import { valuationMachine } from '@pb/workflows';
import { previewMode } from '../../app/env.js';
import {
  describeActionError,
  describeRefusal,
  useCreateValuation,
  usePreviewReset,
  useValuationCommand,
} from '../../app/mutations.js';
import type { ValuationCreateBody } from '../../app/mutations.js';
import { VALUATION_TABS } from '../../app/nav.js';
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
  CountTile,
  EmptyState,
  Field,
  NumCell,
  PageHeader,
  PageSkeleton,
  PARTIAL_PAGE_HINT,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
  TabNav,
  Toolbar,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, formatPct, labelOf, MISSING, plural } from '../../lib/format.js';
import { commandLabel, commandOptions, humanizeState, valuationTone } from '../../lib/states.js';
import type { CommandOption } from '../../lib/states.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { useValuationBatchCommand } from './api.js';
import {
  aboveVarianceFlag,
  ACTIVE_POSITIONS,
  approvedOn,
  batchLabel,
  batchPlanFor,
  batchPlans,
  filterRows,
  isValuationState,
  lastMethodOf,
  latestFirst,
  methodCodes,
  missingMarks,
  periodCounts,
  startablePositions,
  VALUATION_STATES,
  VARIANCE_TITLE,
  vehicleNames,
  versionLabel,
} from './board.js';
import type { BatchPlan } from './board.js';
import { NewValuationDialog } from './NewValuation.js';
import {
  ActionLogCard,
  ActionStatus,
  CommandButtons,
  ReasonDialog,
} from '../../components/WorkflowActions.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import './valuations.css';
import { balanceTiles } from '../../lib/tiles.js';

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
  plans,
  selected,
  busy,
  onToggle,
  onIssue,
}: {
  rows: readonly ValuationRow[];
  roles: readonly string[];
  plans: readonly BatchPlan[];
  selected: ReadonlySet<string>;
  busy: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onIssue: (row: ValuationRow, option: ValuationOption) => void;
}): ReactNode {
  const selectable = plans.length > 0;
  return (
    <TableWrap label="Valuations">
      <table className="pb-table pb-val-table" aria-label="Valuations">
        <thead>
          <tr>
            {selectable ? (
              <th className="pb-val-select">
                <span className="pb-visually-hidden">Select</span>
              </th>
            ) : null}
            <th>Position</th>
            <th>Period</th>
            <th>State</th>
            <th className="num">Prior fair value</th>
            <th className="num">Fair value</th>
            <th className="num">Change</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const plan = batchPlanFor(row, plans);
            return (
              <tr key={row.id}>
                {selectable ? (
                  <td className="pb-val-select">
                    {plan === undefined ? null : (
                      <Checkbox
                        aria-label={`Select ${versionLabel(row)}`}
                        data-testid={`valuation-batch-select-${row.id}`}
                        checked={selected.has(row.id)}
                        disabled={busy}
                        onChange={(_e, d) => onToggle(row.id, d.checked === true)}
                      />
                    )}
                  </td>
                ) : null}
                <td className="pb-val-position">
                  <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
                    {row.companyName}
                  </Link>
                  <span className="pb-cell-sub">
                    <span className="pb-key">{row.investmentNumber}</span>
                    <span>{row.vehicleName}</span>
                  </span>
                </td>
                <td className="pb-val-period">
                  <Link to="/valuations/$id" params={{ id: row.id }}>
                    {formatDate(row.periodEnd)}
                  </Link>
                  <span className="pb-cell-sub">
                    <span>v{row.version}</span>
                    <span>{labelOf(row.method)}</span>
                  </span>
                </td>
                <td className="pb-val-state">
                  <Badge tone={valuationTone(row.state)}>{humanizeState(row.state)}</Badge>
                  {row.approvedAt === null ? null : (
                    <span className="pb-cell-sub">
                      Approved <span>{approvedOn(row.approvedAt)}</span>
                    </span>
                  )}
                </td>
                <NumCell>{formatMoneyM(row.priorFairValue)}</NumCell>
                <NumCell>{formatMoneyM(row.fairValue)}</NumCell>
                <ChangeCell changePct={row.changePct} />
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
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * The batch approval screen's bar (docs/04 M10): how many versions are selected and, per batch
 * command the roles may run, the button that sends them together. A button needs at least one
 * selected version in its starting state and says so while it has none.
 */
function BatchBar({
  plans,
  selected,
  rows,
  busy,
  onRun,
  onClear,
}: {
  plans: readonly BatchPlan[];
  selected: ReadonlySet<string>;
  rows: readonly ValuationRow[];
  busy: boolean;
  onRun: (plan: BatchPlan, ids: string[]) => void;
  onClear: () => void;
}): ReactNode {
  return (
    <div className="pb-val-batch" data-testid="valuation-batch-bar">
      <span className="pb-meta">{plural(selected.size, 'version')} selected</span>
      {plans.map((plan) => {
        const ids = rows
          .filter((r) => selected.has(r.id) && r.state === plan.from)
          .map((r) => r.id);
        const title =
          ids.length === 0
            ? `Select at least one ${humanizeState(plan.from)} version`
            : `${commandLabel(plan.command)} ${plural(ids.length, 'version')} to ${humanizeState(plan.to)}`;
        return (
          <Button
            key={plan.command}
            size="small"
            appearance="primary"
            disabled={ids.length === 0 || busy}
            title={title}
            onClick={() => onRun(plan, ids)}
          >
            {batchLabel(plan.command)}
            {ids.length === 0 ? '' : ` (${ids.length})`}
          </Button>
        );
      })}
      <Button
        size="small"
        appearance="subtle"
        disabled={selected.size === 0 || busy}
        onClick={onClear}
      >
        Clear selection
      </Button>
    </div>
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
      return <StatTile label="Missing marks" value={MISSING} hint={PARTIAL_PAGE_HINT} />;
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
  runBatch: (
    command: ValuationBatchCommand,
    ids: string[],
    rows: readonly ValuationRow[],
    onDone: () => void,
  ) => void;
  resetPreview: () => void;
  busy: boolean;
}

/** Commands, the batch, the new valuation form and the preview reset, each reporting into one action log. */
function useBoardActions(log: ActionLog): BoardActions {
  const command = useValuationCommand();
  const batch = useValuationBatchCommand();
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
  // One entry per version (its new state, or the rule that refused it), then the summary on top.
  const runBatch: BoardActions['runBatch'] = (command, ids, rows, onDone) => {
    const label = (id: string): string => {
      const row = rows.find((r) => r.id === id);
      return row === undefined ? id : versionLabel(row);
    };
    batch.mutate(
      { command, ids },
      {
        onSuccess: ({ results }) => {
          let done = 0;
          for (const r of results) {
            if (r.ok && r.state !== undefined) {
              done += 1;
              log.record(
                'good',
                `${label(r.id)} is now ${humanizeState(r.state)} ${resultSuffix()}`,
              );
            } else {
              const why =
                r.problem === undefined
                  ? 'The action failed.'
                  : describeRefusal(r.problem.status, r.problem.detail);
              log.record('bad', `${commandLabel(command)} for ${label(r.id)}: ${why}`);
            }
          }
          const refused = results.length - done;
          log.record(
            refused === 0 ? 'good' : 'bad',
            `${commandLabel(command)} on ${plural(results.length, 'version')}: ${done} done, ${refused} refused.`,
          );
          onDone();
        },
        onError: (error) =>
          log.record(
            'bad',
            `${commandLabel(command)} on ${plural(ids.length, 'version')}: ${describeActionError(error)}`,
          ),
      },
    );
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
    runBatch,
    resetPreview,
    busy: command.isPending || batch.isPending || create.isPending || reset.isPending,
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reasonFor, setReasonFor] = useState<Pending | null>(null);
  const [newFor, setNewFor] = useState<{ investmentId: string | null } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const log = useActionLog();
  const actions = useBoardActions(log);

  const isOps = roles.includes('operations');
  const plans = batchPlans(roles);
  const periods = latestFirst([...page.periods, ...page.items.map((r) => r.quarterEnd)]);
  const period =
    periodChoice !== null && periods.includes(periodChoice) ? periodChoice : periods[0];
  const activeItems = active.data?.items ?? [];
  // The form offers the positions a version may start for; with only the first page of versions
  // loaded that cannot be told, so every active position is offered and the write decides.
  const positions =
    page.nextCursor === null || period === undefined
      ? startablePositions(activeItems, page.items, period ?? '')
      : activeItems;
  const newTitle =
    activeItems.length === 0
      ? 'No active positions loaded'
      : positions.length === 0
        ? `Every active position has a version for ${formatDate(period)}`
        : undefined;
  const clearSelection = (): void => setSelected(new Set());

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
        <TabNav label="Valuations" items={VALUATION_TABS} />
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
  const partial = page.nextCursor !== null;
  const forPeriod = page.items.filter((r) => r.quarterEnd === period).length;
  const rows = filterRows(page.items, { period, state: stateFilter, vehicle, search });
  const marks = marksStatus(active, page, period);
  const names = vehicleNames(vehicles.data?.items, page.items);
  const start = (row: ValuationRow, option: ValuationOption): void => {
    if (option.needsReason) setReasonFor({ row, option });
    else actions.issue(row, option);
  };
  const toggle = (id: string, checked: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      {header}
      <TabNav label="Valuations" items={VALUATION_TABS} />
      <Gate />
      <div ref={balanceTiles} className="pb-tiles" data-testid="valuation-tiles">
        <CountTile label="Locked" count={counts.locked} hint="Read by reports" partial={partial} />
        <CountTile
          label="In flight"
          count={counts.inFlight}
          hint="Draft, Ops prepared or Deal team approved"
          partial={partial}
        />
        <CountTile
          label="Reopened"
          count={counts.reopened}
          hint="Reopened after Locked"
          partial={partial}
        />
        {marksTile(marks, period)}
      </div>
      <Card testId="valuation-board">
        <SectionHeader
          aside={
            <>
              {`${rows.length} of ${plural(forPeriod, 'version')} for ${formatDate(period)}`}
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
                if (d.optionValue !== undefined) {
                  setPeriodChoice(d.optionValue);
                  clearSelection();
                }
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
        {plans.length > 0 && rows.length > 0 ? (
          <BatchBar
            plans={plans}
            selected={selected}
            rows={rows}
            busy={actions.busy}
            onRun={(plan, ids) => actions.runBatch(plan.command, ids, rows, clearSelection)}
            onClear={clearSelection}
          />
        ) : null}
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
          <VersionTable
            rows={rows}
            roles={roles}
            plans={plans}
            selected={selected}
            busy={actions.busy}
            onToggle={toggle}
            onIssue={start}
          />
        )}
        {page.nextCursor !== null ? (
          <p className="pb-meta" data-testid="valuations-truncated">
            Showing the first {LIST_LIMIT} valuation versions; more exist.
          </p>
        ) : null}
      </Card>
      <div className="pb-two-col">
        <MissingMarksCard
          status={marks}
          period={period}
          canStart={isOps}
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
 * state, the change against the prior Locked mark, the commands the signed-in roles may issue and,
 * for the deal team and approvers, the batch approval of the versions they select.
 */
export function ValuationsPage(): ReactNode {
  const me = useQuery(meQuery);
  const board = useQuery({ ...valuationsQuery({}), placeholderData: keepPreviousData });
  if (board.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (board.isError) {
    return (
      <>
        <PageHeader title="Valuations" meta="Reports read Locked valuations only." />
        <TabNav label="Valuations" items={VALUATION_TABS} />
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
