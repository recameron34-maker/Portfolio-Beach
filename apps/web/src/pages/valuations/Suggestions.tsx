import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
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
  Label,
  Option,
} from '@fluentui/react-components';
import type {
  ValuationSuggestionCommandBody,
  ValuationSuggestionPage,
  ValuationSuggestionRow,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { previewMode } from '../../app/env.js';
import { SUGGESTIONS_PATH } from '../../app/nav.js';
import { flagsQuery, LIST_LIMIT, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
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
import { ActionLogCard, ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  formatPct,
  labelOf,
  MISSING,
  plural,
} from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  describeSuggestionError,
  suggestionQuery,
  suggestionsQuery,
  useSuggestionCommand,
} from './suggestions-api.js';
import {
  acceptSentence,
  applySentence,
  canDecideSuggestions,
  canReadSuggestions,
  currentMarkNote,
  DECIDE_READ_ONLY,
  flagBadges,
  flagSentences,
  isSuggestionStateFilter,
  offerFor,
  REASON_SENTENCE,
  searchFor,
  SOURCE_LABEL,
  SUGGESTION_STATES,
  suggestionLabel,
  SUGGESTIONS_EMPTY,
  SUGGESTIONS_OFF,
  SUGGESTIONS_READERS,
  suggestionsOn,
  suggestionStateWord,
  suggestionTone,
  supersededText,
  VERSION_IN_APPROVAL,
} from './suggestions.js';
import type { SuggestionStateFilter } from './suggestions.js';
import { SuggestionWorkings } from './SuggestionWorkings.js';
import { ValuationTabs } from './ValuationTabs.js';
import './valuations.css';

const TITLE = 'Valuation suggestions';

const NOT_A_MARK =
  'A suggestion is not a mark. Operations opens a draft valuation from it, and the draft is prepared and approved like any other before it is Locked.';

const FILTERS: readonly SuggestionStateFilter[] = [...SUGGESTION_STATES, 'all'];

function Badges({ row }: { row: ValuationSuggestionRow }): ReactNode {
  const badges = flagBadges(row.flags);
  if (badges.length === 0) return null;
  return (
    <span className="pb-val-flags">
      {badges.map((b) => (
        <span key={b.label} title={b.title}>
          <Badge tone={b.tone}>{b.label}</Badge>
        </span>
      ))}
    </span>
  );
}

/** A figure with a muted line under it, right-aligned; the placeholder alone when there is no figure. */
function FigureCell({ value, sub }: { value: string; sub?: string | undefined }): ReactNode {
  if (value === MISSING && sub === undefined) return <NumCell>{MISSING}</NumCell>;
  return (
    <td className={value === MISSING ? 'num is-missing' : 'num'}>
      {value}
      {sub === undefined ? null : <span className="pb-cell-sub">{sub}</span>}
    </td>
  );
}

/** What became of a suggestion that is no longer Open, with the link that follows it. */
function Outcome({
  row,
  state,
}: {
  row: ValuationSuggestionRow;
  state: SuggestionStateFilter;
}): ReactNode {
  if (row.state === 'Accepted' && row.valuationId !== null)
    return (
      <span className="pb-cell-sub">
        <Link to="/valuations/$id" params={{ id: row.valuationId }}>
          Open the valuation
        </Link>
      </span>
    );
  if (row.state !== 'Superseded') return null;
  return (
    <span className="pb-cell-sub">
      <span>{supersededText(row)}</span>
      {row.supersededById === null ? null : (
        <Link to={SUGGESTIONS_PATH} search={searchFor(row.supersededById, state)}>
          Open the replacement
        </Link>
      )}
    </span>
  );
}

function SuggestionsTable({
  rows,
  state,
  selectedId,
}: {
  rows: readonly ValuationSuggestionRow[];
  state: SuggestionStateFilter;
  selectedId: string | undefined;
}): ReactNode {
  return (
    <TableWrap label={TITLE}>
      <table className="pb-table pb-val-table" aria-label={TITLE} data-testid="suggestions-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>Quarter</th>
            <th className="num">Suggested mark</th>
            <th className="num">Current mark</th>
            <th className="num">Change</th>
            <th className="num">Net of flows</th>
            <th>Source</th>
            <th>State</th>
            <th>Workings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { comparison, currentMark } = row;
            const selected = row.id === selectedId;
            return (
              <tr
                key={row.id}
                className={selected ? 'is-selected' : undefined}
                data-testid={`suggestion-row-${row.id}`}
              >
                <td className="pb-val-position">
                  <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
                    {row.companyName}
                  </Link>
                  <span className="pb-cell-sub">
                    <span className="pb-key">{row.investmentNumber}</span>
                    <span>{row.vehicleName}</span>
                  </span>
                </td>
                <td className="pb-nowrap">{formatDate(row.periodEnd)}</td>
                <FigureCell
                  value={formatMoneyM(row.suggestedValue)}
                  sub={row.suggestedValue === null ? 'Not calculable' : undefined}
                />
                <FigureCell
                  value={formatMoneyM(currentMark?.value)}
                  sub={
                    currentMark === null ? 'No earlier Locked mark' : currentMarkNote(currentMark)
                  }
                />
                <FigureCell
                  value={formatMoneyM(comparison.change)}
                  sub={comparison.changePct === null ? undefined : formatPct(comparison.changePct)}
                />
                <FigureCell
                  value={formatMoneyM(comparison.netOfFlows)}
                  sub={
                    comparison.netOfFlowsPct === null
                      ? undefined
                      : formatPct(comparison.netOfFlowsPct)
                  }
                />
                <td>
                  <span>{SOURCE_LABEL[row.basis]}</span>
                  {row.reasonCode === null ? null : (
                    <span className="pb-cell-sub">{REASON_SENTENCE[row.reasonCode]}</span>
                  )}
                  <Badges row={row} />
                </td>
                <td className="pb-val-state">
                  <Badge tone={suggestionTone(row.state)}>{suggestionStateWord(row.state)}</Badge>
                  <Outcome row={row} state={state} />
                </td>
                <td>
                  {selected ? (
                    <span className="pb-meta">Shown above</span>
                  ) : (
                    <Link
                      to={SUGGESTIONS_PATH}
                      search={searchFor(row.id, state)}
                      aria-label={`Workings, ${suggestionLabel(row)}`}
                    >
                      Workings
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

type Pending =
  | { kind: 'accept'; row: ValuationSuggestionRow }
  | { kind: 'applyToDraft'; row: ValuationSuggestionRow; draftPeriodEnd: string }
  | { kind: 'dismiss'; row: ValuationSuggestionRow };

/** What a person reads before a draft valuation is opened, or a value put on the Draft already open. */
function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: Exclude<Pending, { kind: 'dismiss' }>;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const { row } = pending;
  const title =
    pending.kind === 'accept' ? 'Open a draft valuation' : 'Use this value on the draft';
  const flags = flagSentences(row.flags);
  return (
    <Dialog
      open
      onOpenChange={(_e, d) => {
        if (!d.open) onCancel();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent className="pb-dialog-content">
            <p className="pb-meta">{suggestionLabel(row)}</p>
            <p>
              {pending.kind === 'accept'
                ? acceptSentence(row)
                : applySentence(row, { periodEnd: pending.draftPeriodEnd })}
            </p>
            {flags.length === 0 ? null : (
              <ul className="pb-list" aria-label="Flags on this suggestion">
                {flags.map((sentence) => (
                  <li key={sentence}>{sentence}</li>
                ))}
              </ul>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={onConfirm}>
              {title}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Who decided a suggestion that is no longer Open, when and what followed. */
function DecisionNote({
  row,
  state,
}: {
  row: ValuationSuggestionRow;
  state: SuggestionStateFilter;
}): ReactNode {
  if (row.state === 'Open') return null;
  const when = row.decidedAt === null ? null : formatDateTime(row.decidedAt);
  const by = row.decidedBy === null ? '' : ` by ${row.decidedBy.name}`;
  const at = when === null ? '' : ` on ${when}`;
  if (row.state === 'Accepted')
    return (
      <p className="pb-notice pb-notice-good" data-testid="suggestion-decision">
        Accepted{by}
        {at}.{' '}
        {row.valuationId === null ? null : (
          <Link to="/valuations/$id" params={{ id: row.valuationId }}>
            Open the valuation it went onto
          </Link>
        )}
      </p>
    );
  if (row.state === 'Dismissed')
    return (
      <p className="pb-notice" data-testid="suggestion-decision">
        Dismissed{by}
        {at}
        {row.decisionReason === null ? '.' : `: ${row.decisionReason}`}
      </p>
    );
  return (
    <p className="pb-notice" data-testid="suggestion-decision">
      {row.supersededById === null ? (
        supersededText(row)
      ) : (
        <>
          Replaced by a newer suggestion{at}.{' '}
          <Link to={SUGGESTIONS_PATH} search={searchFor(row.supersededById, state)}>
            Open the replacement
          </Link>
        </>
      )}
    </p>
  );
}

function Tiles({ row }: { row: ValuationSuggestionRow }): ReactNode {
  const { comparison, currentMark } = row;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="suggestion-tiles">
      <StatTile
        label="Suggested mark"
        value={formatMoneyM(row.suggestedValue)}
        hint={row.suggestedValue === null ? 'Not calculable this quarter' : labelOf(row.method)}
      />
      <StatTile
        label="Current mark"
        value={formatMoneyM(currentMark?.value)}
        hint={
          currentMark === null
            ? 'No Locked mark of an earlier quarter'
            : currentMarkNote(currentMark)
        }
      />
      <StatTile
        label="Change"
        value={formatPct(comparison.changePct)}
        hint={
          comparison.change === null
            ? 'Against the current mark'
            : `${formatMoneyM(comparison.change)} against the current mark`
        }
        tone={comparison.variance ? 'watch' : undefined}
      />
      <StatTile
        label="Net of flows"
        value={formatPct(comparison.netOfFlowsPct)}
        hint={
          comparison.netOfFlows === null
            ? "Shown when the statement opens at the previous quarter's mark"
            : `${formatMoneyM(comparison.netOfFlows)} after contributions and distributions`
        }
      />
    </div>
  );
}

/**
 * What operations can do with an Open suggestion: open a draft valuation, put the value on the
 * Draft already open, or dismiss it with a reason. Which of the first two is offered follows the
 * valuation version in progress for the quarter; the API judges the command all the same.
 */
function Actions({
  row,
  roles,
  switchedOn,
  busy,
  onAsk,
}: {
  row: ValuationSuggestionRow;
  roles: readonly string[];
  switchedOn: boolean;
  busy: boolean;
  onAsk: (pending: Pending) => void;
}): ReactNode {
  const offer = offerFor(row);
  if (offer.kind === 'decided') return null;
  if (!canDecideSuggestions(roles))
    return (
      <p className="pb-meta" data-testid="suggestion-read-only">
        {DECIDE_READ_ONLY}
      </p>
    );
  const off = switchedOn ? {} : { title: 'Suggestions are switched off' };
  return (
    <div className="pb-val-actions" data-testid="suggestion-actions">
      {offer.kind === 'accept' ? (
        <Button
          size="small"
          appearance="primary"
          disabledFocusable={busy || !switchedOn}
          {...off}
          onClick={() => onAsk({ kind: 'accept', row })}
        >
          Open a draft valuation
        </Button>
      ) : offer.kind === 'applyToDraft' ? (
        <Button
          size="small"
          appearance="primary"
          disabledFocusable={busy || !switchedOn}
          {...off}
          onClick={() =>
            onAsk({ kind: 'applyToDraft', row, draftPeriodEnd: offer.draft.periodEnd })
          }
        >
          Use this value on the draft
        </Button>
      ) : null}
      <Button
        size="small"
        appearance="secondary"
        disabledFocusable={busy}
        onClick={() => onAsk({ kind: 'dismiss', row })}
      >
        Dismiss
      </Button>
      {previewMode ? <SimulatedBadge /> : null}
      {offer.kind === 'blocked' ? (
        <p className="pb-meta" data-testid="suggestion-blocked">
          {VERSION_IN_APPROVAL}{' '}
          <Link to="/valuations/$id" params={{ id: offer.version.valuationId }}>
            Open the valuation
          </Link>
        </p>
      ) : offer.kind === 'applyToDraft' ? (
        <p className="pb-meta">
          A draft is open for this quarter:{' '}
          <Link to="/valuations/$id" params={{ id: offer.draft.valuationId }}>
            {formatMoneyM(offer.draft.fairValue)}, {labelOf(offer.draft.method)}, dated{' '}
            {formatDate(offer.draft.periodEnd)}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** One suggestion with its figures, its workings and what can be done with it. */
function SuggestionCard({
  row,
  roles,
  state,
  switchedOn,
  busy,
  onAsk,
}: {
  row: ValuationSuggestionRow;
  roles: readonly string[];
  state: SuggestionStateFilter;
  switchedOn: boolean;
  busy: boolean;
  onAsk: (pending: Pending) => void;
}): ReactNode {
  const fileName = row.source.fileName;
  return (
    <Card testId="suggestion-detail">
      <SectionHeader
        aside={<Badge tone={suggestionTone(row.state)}>{suggestionStateWord(row.state)}</Badge>}
      >
        {suggestionLabel(row)}
      </SectionHeader>
      <p className="pb-meta pb-meta-list">
        <span>
          <Link to="/portfolio/$id" params={{ id: row.investmentId }}>
            {row.investmentNumber}
          </Link>
        </span>
        <span>{row.vehicleName}</span>
        <span>{SOURCE_LABEL[row.basis]}</span>
        <span>
          <Link to="/documents/extraction/$id" params={{ id: row.source.extractionRunId }}>
            {fileName ?? 'Source document'}
          </Link>
        </span>
        <span>
          <Link to={SUGGESTIONS_PATH} search={searchFor(undefined, state)}>
            Close
          </Link>
        </span>
      </p>
      <Tiles row={row} />
      <Badges row={row} />
      <DecisionNote row={row} state={state} />
      <SuggestionWorkings row={row} />
      <Actions row={row} roles={roles} switchedOn={switchedOn} busy={busy} onAsk={onAsk} />
    </Card>
  );
}

/** The suggestion named in the address: from the list when it is there, else read on its own. */
function Selected({
  id,
  list,
  listSettled,
  children,
}: {
  id: string;
  list: ValuationSuggestionPage | undefined;
  listSettled: boolean;
  children: (row: ValuationSuggestionRow) => ReactNode;
}): ReactNode {
  const fromList = list?.items.find((row) => row.id === id);
  const q = useQuery({ ...suggestionQuery(id), enabled: listSettled && fromList === undefined });
  if (fromList !== undefined) return children(fromList);
  if (q.data !== undefined) return children(q.data);
  if (q.isError) {
    const hidden = q.error instanceof ApiError && q.error.status === 404;
    return hidden ? (
      <ErrorState
        title="Suggestion not found or not visible to you"
        detail="There is no valuation suggestion with this id in your view of the portfolio."
      />
    ) : (
      <UnavailableState
        card
        error={q.error}
        subject="This suggestion"
        errorTitle="Suggestion unavailable"
        testId="suggestion-unavailable"
      />
    );
  }
  return (
    <Card>
      <PageSkeleton rows={4} />
    </Card>
  );
}

function useDecide(log: ActionLog): {
  decide: (row: ValuationSuggestionRow, body: ValuationSuggestionCommandBody) => void;
  busy: boolean;
} {
  const command = useSuggestionCommand();
  const decide = (row: ValuationSuggestionRow, body: ValuationSuggestionCommandBody): void => {
    const subject = suggestionLabel(row);
    command.mutate(
      { id: row.id, rowVersion: row.rowVersion, body },
      {
        onSuccess: (updated) => {
          const value = formatMoneyM(updated.suggestedValue);
          const done =
            body.command === 'accept'
              ? `Draft valuation opened at ${value} for ${subject}`
              : body.command === 'applyToDraft'
                ? `${value} and the method ${labelOf(updated.method)} put on the draft for ${subject}`
                : `Suggestion dismissed for ${subject}`;
          log.record('good', `${done} ${resultSuffix()}`);
        },
        onError: (error) => log.record('bad', `${subject}: ${describeSuggestionError(error)}`),
      },
    );
  };
  return { decide, busy: command.isPending };
}

function Queue({
  roles,
  initialState,
  selectedId,
}: {
  roles: readonly string[];
  initialState: SuggestionStateFilter;
  selectedId: string | undefined;
}): ReactNode {
  const [state, setState] = useState<SuggestionStateFilter>(initialState);
  const flags = useQuery(flagsQuery);
  const list = useQuery({
    ...suggestionsQuery(state === 'Open' ? {} : { state }),
    placeholderData: keepPreviousData,
  });
  const log = useActionLog();
  const { decide, busy } = useDecide(log);
  const [pending, setPending] = useState<Pending | null>(null);
  // A dialog has no trigger of its own, so when it closes focus goes back to the button that opened it.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pending !== null || opener.current === null) return;
    const el = opener.current;
    opener.current = null;
    if (el.isConnected) el.focus();
  }, [pending]);
  const ask = (next: Pending): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending(next);
  };

  const switchedOn = suggestionsOn(flags.data);
  const page = list.data;
  const tabs = <ValuationTabs />;
  const header = (
    <PageHeader title={TITLE} meta={page === undefined ? undefined : `${page.openCount} open`} />
  );

  return (
    <>
      {header}
      {tabs}
      <div className="pb-val-gates">
        <p className="pb-notice" data-testid="suggestions-gate">
          {NOT_A_MARK}
        </p>
        {switchedOn ? null : (
          <p className="pb-notice" data-testid="suggestions-off">
            {SUGGESTIONS_OFF}
          </p>
        )}
      </div>
      {selectedId === undefined ? null : (
        <Selected id={selectedId} list={page} listSettled={!list.isPending}>
          {(row) => (
            <SuggestionCard
              row={row}
              roles={roles}
              state={state}
              switchedOn={switchedOn}
              busy={busy}
              onAsk={ask}
            />
          )}
        </Selected>
      )}
      <Card testId="suggestions-card">
        <SectionHeader
          aside={
            page === undefined ? undefined : (
              <>
                {plural(page.items.length, 'suggestion')}
                <SimulatedBadge />
              </>
            )
          }
        >
          Suggestions
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="suggestion-state">State</Label>
            <Dropdown
              id="suggestion-state"
              className="pb-val-filter"
              value={suggestionStateWord(state)}
              selectedOptions={[state]}
              onOptionSelect={(_e, d) => {
                if (isSuggestionStateFilter(d.optionValue)) setState(d.optionValue);
              }}
            >
              {FILTERS.map((f) => (
                <Option key={f} value={f}>
                  {suggestionStateWord(f)}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        <ActionStatus latest={log.latest} testId="suggestion-action-status" />
        {list.isPending ? (
          <PageSkeleton rows={4} />
        ) : list.isError ? (
          <UnavailableState
            inline
            error={list.error}
            subject="Valuation suggestions"
            testId="suggestions-unavailable"
          />
        ) : list.data.items.length === 0 ? (
          state === 'Open' ? (
            <EmptyState
              title={SUGGESTIONS_EMPTY.title}
              detail={SUGGESTIONS_EMPTY.detail}
              testId="suggestions-empty"
            />
          ) : (
            <EmptyState
              title="No suggestions in this state"
              detail="Pick another state to see the others."
              testId="suggestions-empty"
            />
          )
        ) : (
          <SuggestionsTable rows={list.data.items} state={state} selectedId={selectedId} />
        )}
        {page !== undefined && page.nextCursor !== null ? (
          <p className="pb-meta" data-testid="suggestions-truncated">
            Showing the first {LIST_LIMIT} suggestions; more exist.
          </p>
        ) : null}
      </Card>
      <ActionLogCard entries={log.entries} />
      {pending === null ? null : pending.kind === 'dismiss' ? (
        <ReasonDialog
          title="Dismiss"
          subject={suggestionLabel(pending.row)}
          onCancel={() => setPending(null)}
          onSubmit={(reason) => {
            decide(pending.row, { command: 'dismiss', reason });
            setPending(null);
          }}
        />
      ) : (
        <ConfirmDialog
          pending={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            decide(pending.row, { command: pending.kind });
            setPending(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The Suggestions tab (docs/04 M10, docs/18 section 14, decision 0023): the marks worked out from
 * approved capital account statements and sponsor reports, each set against the mark on record,
 * with its workings, the checks of its statement and the other sources of the quarter. Operations
 * opens a draft valuation from one, puts its value on the Draft already open, or dismisses it
 * with a reason; the deal team, approvers and auditors read. A role that does not read
 * suggestions is told so and no request is sent for it.
 */
export function SuggestionsPage(): ReactNode {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/app/valuations/suggestions' });
  // The roles decide whether anything is asked for at all, so nothing is said until they are known.
  if (me.isPending) return <PageSkeleton rows={6} />;
  const roles = me.data?.roles ?? [];
  if (!canReadSuggestions(roles)) {
    return (
      <>
        <PageHeader title={TITLE} />
        <ValuationTabs />
        <Card>
          <EmptyState
            title="Not shown to your role"
            detail={SUGGESTIONS_READERS}
            testId="suggestions-not-shown"
          />
        </Card>
      </>
    );
  }
  return <Queue roles={roles} initialState={search.state ?? 'Open'} selectedId={search.id} />;
}
