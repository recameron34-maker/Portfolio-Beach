import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import type {
  ExtractedValue,
  ExtractionFinding,
  ExtractionRunCommandBody,
  ExtractionRunDetail,
  SuggestionRunOutcome,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { SUGGESTIONS_PATH } from '../../app/nav.js';
import { useExtractionRunCommand } from '../../app/mutations.js';
import { extractionRunQuery, meQuery } from '../../app/queries.js';
import { useJustChanged, useReducedMotion } from '../../components/motion.js';
import type { JustChangedProps } from '../../components/motion.js';
import { plainWords } from '../../components/plain-words.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  AiDraftBadge,
  Badge,
  Breadcrumbs,
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
import { ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import { formatDate, formatDateTime, labelOf, MISSING, plural } from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { runStateTone, runStateWord } from '../../lib/states.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import { confidenceText } from '../documents/documents.js';
import { ApproveDialog, EditValueDialog } from './dialogs.js';
import {
  acceptBlocker,
  acceptCleanPhrase,
  approvalText,
  approvalTone,
  approveBlocker,
  approvedPhrase,
  canReview,
  costText,
  decisionPhrase,
  decisionTone,
  decisionWord,
  describeExtractionError,
  EXTRACTION_FORBIDDEN,
  findQuote,
  finalValueText,
  firstPage,
  NARRATIVE_FIELDS,
  promotedPeriod,
  retriedPhrase,
  REVIEW_READ_ONLY,
  reviewOrder,
  runGates,
  runSchemaTraits,
  statementReading,
  tokensText,
  undecidedClean,
  validationTone,
  validationWord,
  valueText,
} from './extraction.js';
import { suggestionsQuery } from '../valuations/suggestions-api.js';
import { canReadSuggestions, RELINK_NOTE, runOutcomeText } from '../valuations/suggestions.js';
import { PageView } from './PageView.js';
import './extraction.css';

type Dialog =
  | { kind: 'edit'; value: ExtractedValue }
  | { kind: 'reject'; field: string; label: string }
  | { kind: 'approve' };

/** The command to send, with the label the status phrase names. */
interface Issue {
  body: ExtractionRunCommandBody;
  label: string;
}

/** Where a run's page sits: Documents, then Extraction. */
const CRUMBS = [
  { label: 'Documents', to: '/documents' },
  { label: 'Extraction', to: '/documents/extraction' },
];

function Banner({ detail }: { detail: ExtractionRunDetail }): ReactNode {
  const { run, document } = detail;
  return (
    <PageHeader
      crumbs={CRUMBS}
      title={document.title}
      meta={
        <span className="pb-meta-list">
          <span className="pb-marker-row">
            <Badge tone={runStateTone(run.state)}>{runStateWord(run.state)}</Badge>
            <Badge tone={approvalTone(run)}>{approvalText(run)}</Badge>
          </span>
          {run.investmentId === null ? (
            <span>{run.companyName ?? 'No linked investment'}</span>
          ) : (
            <span>
              <Link to="/portfolio/$id" params={{ id: run.investmentId }}>
                {run.companyName ?? run.investmentNumber ?? 'Investment'}
              </Link>
              {run.investmentNumber === null ? null : ` ${run.investmentNumber}`}
            </span>
          )}
          <span>Period {formatDate(run.periodEnd)}</span>
          <span>
            <span className="pb-meta-clip" title={run.fileName}>
              {run.fileName}
            </span>
          </span>
          {run.requestedBy === null ? null : <span>Requested by {run.requestedBy}</span>}
        </span>
      }
      testId="run-banner"
    />
  );
}

/**
 * How the run was made, folded under the header: what it was read as, the model and prompt
 * version, the tokens and the cost, in words. The prompt's and schema's own names stay in the
 * record; the reader gets the document type and the version.
 */
function RunDetails({ detail }: { detail: ExtractionRunDetail }): ReactNode {
  const { run } = detail;
  const tokens =
    run.tokensIn !== null && run.tokensOut !== null
      ? `${run.tokensIn} tokens in, ${run.tokensOut} out`
      : `Tokens ${tokensText(run.tokensIn, run.tokensOut)}`;
  return (
    <details className="pb-details pb-run-details" data-testid="run-details">
      <summary>Run details</summary>
      <p className="pb-meta-list">
        <span>Read as {labelOf(run.schemaId)}</span>
        <span>
          Model: {run.modelId ?? MISSING}, prompt version {run.promptVersion}
        </span>
        <span>{tokens}</span>
        <span>Cost {costText(run.costUsd)}</span>
      </p>
    </details>
  );
}

function Tiles({ detail }: { detail: ExtractionRunDetail }): ReactNode {
  const c = detail.run.counts;
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="run-tiles">
      <StatTile label="Values" value={String(c.values)} hint="Fields of the schema" />
      <StatTile label="Clean" value={String(c.clean)} hint="Passed every rule" />
      <StatTile
        label="Flagged"
        value={String(c.flagged)}
        hint="Reviewed first"
        tone={c.flagged > 0 ? 'watch' : undefined}
      />
      <StatTile
        label="Invalid"
        value={String(c.invalid)}
        hint="Edited or rejected, never promoted as answered"
        tone={c.invalid > 0 ? 'bad' : undefined}
      />
      <StatTile label="Decided" value={String(c.decided)} hint="Accepted, edited or rejected" />
    </div>
  );
}

/**
 * A value's validation as a dot and a word, then its findings: the count (the disclosure holds the
 * messages) and the rule identifiers under it. The severity is the validation word's, said once.
 */
function FindingsCell({
  state,
  findings,
}: {
  state: ExtractedValue['validationState'];
  findings: readonly ExtractionFinding[];
}): ReactNode {
  return (
    <td>
      <Badge tone={validationTone(state)}>{validationWord(state)}</Badge>
      {findings.length === 0 ? null : (
        <>
          <details className="pb-details pb-findings">
            <summary>{plural(findings.length, 'finding')}</summary>
            <ul className="pb-list">
              {findings.map((f, i) => (
                <li key={`${f.ruleId}-${i}`}>
                  {f.ruleId}: {f.message}
                </li>
              ))}
            </ul>
          </details>
          <span className="pb-rule-id">
            {findings.map((f, i) => (
              <Fragment key={`${f.ruleId}-${i}`}>
                {i === 0 ? null : ', '}
                <span title={f.message}>{f.ruleId}</span>
              </Fragment>
            ))}
          </span>
        </>
      )}
    </td>
  );
}

function DecisionCell({ v, once }: { v: ExtractedValue; once: boolean }): ReactNode {
  return (
    <td>
      {v.decision === null ? (
        <span className="pb-meta">{MISSING}</span>
      ) : (
        <Badge tone={decisionTone(v.decision)}>{decisionWord(v.decision)}</Badge>
      )}
      {once || (v.decidedBy === null && v.decidedAt === null) ? null : (
        <span className="pb-cell-sub">
          {v.decidedBy === null ? null : <span>By {v.decidedBy}</span>}
          {v.decidedAt === null ? null : <span>{formatDateTime(v.decidedAt)}</span>}
        </span>
      )}
    </td>
  );
}

/**
 * Who decided and when, when every decided value shares both (a reviewer's one pass): said once
 * above the table, so each decision cell shows its word alone. Null when the values differ, or
 * fewer than two are decided.
 */
function sharedDecision(values: readonly ExtractedValue[]): string | null {
  const decided = values.filter((v) => v.decidedBy !== null || v.decidedAt !== null);
  const first = decided[0];
  if (first === undefined || decided.length < 2) return null;
  if (!decided.every((v) => v.decidedBy === first.decidedBy && v.decidedAt === first.decidedAt))
    return null;
  const who = first.decidedBy === null ? '' : ` by ${first.decidedBy}`;
  const when = first.decidedAt === null ? '' : `, ${formatDateTime(first.decidedAt)}`;
  return `Every decision below was made${who}${when}.`;
}

/** Where a value was read: its page as a command that shows it there, then the quote. */
function SourceCell({
  v,
  onHover,
  onShow,
}: {
  v: ExtractedValue;
  onHover: (field: string | null) => void;
  onShow: (v: ExtractedValue) => void;
}): ReactNode {
  if (v.page === null && v.quote === null) {
    return <td className="is-missing">{MISSING}</td>;
  }
  return (
    <td className="pb-extraction-source">
      {v.page === null ? null : (
        <button
          type="button"
          className="pb-btn-quiet pb-extraction-page-link"
          aria-label={`Show ${v.label} on page ${v.page}`}
          onFocus={() => onHover(v.field)}
          onBlur={() => onHover(null)}
          onClick={() => onShow(v)}
        >
          Page {v.page}
        </button>
      )}
      {v.quote === null ? null : <span className="pb-extraction-quote">{v.quote}</span>}
    </td>
  );
}

function ValuesTable({
  values,
  active,
  reviewable,
  blocked,
  busy,
  actionsShown,
  decidedOnce,
  onHover,
  onShow,
  onAccept,
  onEdit,
  onReject,
  capture,
  rowProps,
}: {
  values: readonly ExtractedValue[];
  active: string | null;
  reviewable: boolean;
  blocked: string | null;
  busy: boolean;
  /** The roles may review and the run can still be decided: the action buttons are rendered. */
  actionsShown: boolean;
  /** Who decided and when is said once above the table, not in each decision cell. */
  decidedOnce: boolean;
  onHover: (field: string | null) => void;
  onShow: (v: ExtractedValue) => void;
  onAccept: (v: ExtractedValue) => void;
  onEdit: (v: ExtractedValue) => void;
  onReject: (v: ExtractedValue) => void;
  capture: (key: string, el: HTMLButtonElement | null) => void;
  rowProps: (key: string) => JustChangedProps;
}): ReactNode {
  return (
    <TableWrap label="Extracted values">
      <table
        className="pb-table pb-extraction-fields"
        aria-label="Extracted values"
        data-testid="run-fields"
      >
        <thead>
          <tr>
            <th>Field</th>
            <th className="num">Value</th>
            <th>Source</th>
            <th className="num">Confidence</th>
            <th>Validation</th>
            <th>Decision</th>
            {actionsShown ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {values.map((v) => {
            const cannotAccept = acceptBlocker(v);
            const off = blocked ?? cannotAccept;
            const absent = v.value === null && v.page === null;
            return (
              <tr
                key={v.field}
                className={active === v.field ? 'is-selected' : undefined}
                data-testid={`run-field-${v.field}`}
                onMouseEnter={() => onHover(v.field)}
                onMouseLeave={() => onHover(null)}
                {...rowProps(v.field)}
              >
                <td className="pb-extraction-field">
                  <span>{v.label}</span>
                  {v.required ? <span className="pb-cell-sub">required</span> : null}
                </td>
                <td className="num">
                  <span className={absent ? 'pb-meta' : undefined}>{finalValueText(v)}</span>
                  {v.decision === 'edited' ? (
                    <span className="pb-extraction-was">
                      was {valueText(v.value, v.unit, v.kind)}
                    </span>
                  ) : absent ? (
                    <span className="pb-extraction-was">Not in the document</span>
                  ) : null}
                </td>
                <SourceCell v={v} onHover={onHover} onShow={onShow} />
                <NumCell>{confidenceText(v.confidence)}</NumCell>
                <FindingsCell state={v.validationState} findings={v.findings} />
                <DecisionCell v={v} once={decidedOnce} />
                {actionsShown ? (
                  <td>
                    <span className="pb-extraction-actions">
                      <Button
                        ref={(el) => capture(`accept:${v.field}`, el)}
                        size="small"
                        appearance="subtle"
                        aria-label={`Accept, ${v.label}`}
                        disabledFocusable={!reviewable || busy || cannotAccept !== null}
                        {...(off === null ? {} : { title: off })}
                        onClick={() => onAccept(v)}
                      >
                        Accept
                      </Button>
                      <Button
                        ref={(el) => capture(`edit:${v.field}`, el)}
                        size="small"
                        appearance="subtle"
                        aria-label={`Edit, ${v.label}`}
                        disabledFocusable={!reviewable || busy}
                        {...(blocked === null ? {} : { title: blocked })}
                        onClick={() => onEdit(v)}
                      >
                        Edit
                      </Button>
                      <Button
                        ref={(el) => capture(`reject:${v.field}`, el)}
                        size="small"
                        appearance="subtle"
                        aria-label={`Reject, ${v.label}`}
                        disabledFocusable={!reviewable || busy}
                        {...(blocked === null ? {} : { title: blocked })}
                        onClick={() => onReject(v)}
                      >
                        Reject
                      </Button>
                    </span>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function NarrativeCard({
  detail,
  reviewable,
  blocked,
  busy,
  offered,
  onIssue,
  capture,
}: {
  detail: ExtractionRunDetail;
  reviewable: boolean;
  blocked: string | null;
  busy: boolean;
  offered: boolean;
  onIssue: (issue: Issue) => void;
  capture: (key: string, el: HTMLButtonElement | null) => void;
}): ReactNode {
  // No button there could be pressed once the run cannot be reviewed (approved, failed): the
  // sentence over the values table says why, so the narrative shows none either.
  const actions = (field: string, label: string): ReactNode =>
    !offered || !reviewable ? null : (
      <span className="pb-extraction-actions">
        <Button
          ref={(el) => capture(`accept:${field}`, el)}
          size="small"
          appearance="subtle"
          aria-label={`Accept, ${label}`}
          disabledFocusable={!reviewable || busy}
          {...(blocked === null ? {} : { title: blocked })}
          onClick={() => onIssue({ body: { command: 'accept', field }, label })}
        >
          Accept
        </Button>
        <Button
          ref={(el) => capture(`reject:${field}`, el)}
          size="small"
          appearance="subtle"
          aria-label={`Reject, ${label}`}
          disabledFocusable={!reviewable || busy}
          {...(blocked === null ? {} : { title: blocked })}
          onClick={() => onIssue({ body: { command: 'reject', field }, label })}
        >
          Reject
        </Button>
      </span>
    );
  const empty = detail.highlights.length === 0 && detail.commentary === null;
  return (
    <Card testId="run-narrative">
      <SectionHeader aside={detail.run.approvedBy === null ? <AiDraftBadge /> : undefined}>
        Highlights and commentary
      </SectionHeader>
      {empty ? (
        <EmptyState
          title="No narrative drafted"
          detail="The model writes business highlights and a commentary from the figures it extracted; none came back for this run."
        />
      ) : (
        <div className="pb-extraction-narrative">
          <div>
            <h3>
              <span>Highlights</span>
              {actions(NARRATIVE_FIELDS.highlights, 'Highlights')}
            </h3>
            {detail.highlights.length === 0 ? (
              <p className="pb-meta">None drafted.</p>
            ) : (
              <ul className="pb-list" aria-label="Drafted highlights">
                {detail.highlights.map((h, i) => (
                  <li key={`${i}-${h}`}>{h}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>
              <span>Commentary</span>
              {actions(NARRATIVE_FIELDS.commentary, 'Commentary')}
            </h3>
            <p>{detail.commentary ?? 'None drafted.'}</p>
          </div>
        </div>
      )}
      <p className="pb-meta pb-extraction-page-note">
        Drafted from the extracted figures only. Accepting the clean values accepts the draft if it
        passed the style rules.
      </p>
    </Card>
  );
}

/**
 * What the approval of this run did to the valuation suggestions of its position and quarter
 * (decision 0023): one was opened or replaced, the open one is unchanged, or no mark is
 * suggested and why. Under a statement's line, what to do when it sits on the wrong position:
 * a classified document cannot be relinked yet.
 */
function SuggestionOutcome({
  outcome,
  statement,
}: {
  outcome: SuggestionRunOutcome;
  statement: boolean;
}): ReactNode {
  const { text, linked } = runOutcomeText(outcome);
  return (
    <>
      <p className="pb-notice" data-testid="run-suggestion">
        {/* One child, so the link stays inside the sentence: a notice lays its children out in a row. */}
        <span>
          {text}
          {outcome.outcome === 'none' ? null : '.'}
          {linked && outcome.suggestionId !== null ? (
            <>
              {' '}
              <Link to={SUGGESTIONS_PATH} search={{ id: outcome.suggestionId }}>
                Open the suggestion
              </Link>
            </>
          ) : null}
        </span>
      </p>
      {statement ? (
        <p className="pb-meta" data-testid="run-relink-note">
          {RELINK_NOTE}
        </p>
      ) : null}
    </>
  );
}

function RunBody({
  detail,
  roles,
}: {
  detail: ExtractionRunDetail;
  roles: readonly string[];
}): ReactNode {
  const pageSelectId = useId();
  const navigate = useNavigate();
  const log = useActionLog();
  const command = useExtractionRunCommand();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(() => firstPage(detail));
  // Once the reader picks another page, the drawn page fades in where the old one was; and a pick
  // from a value's source brings its quote into view inside the page's frame.
  const reduced = useReducedMotion();
  const [swapped, setSwapped] = useState(false);
  const [pick, setPick] = useState(0);
  const frame = useRef<HTMLDivElement | null>(null);
  const changed = useJustChanged();
  const gates = runGates(detail.run, roles);
  const traits = runSchemaTraits(detail.run.schemaId);
  const readAs = statementReading(detail);
  const approveLabel = traits.promotes ? 'Approve and promote' : 'Approve';
  const offered = canReview(roles);
  const values = reviewOrder(detail.values);
  const busy = command.isPending;
  // Read once the run is approved, for the roles that read suggestions and nobody else.
  const suggested = useQuery({
    ...suggestionsQuery({ extractionRunId: detail.run.id, state: 'all' }),
    enabled: canReadSuggestions(roles) && detail.run.approvedBy !== null,
  });
  const runOutcome = suggested.data?.runOutcome ?? null;

  // The reason and edit dialogs have no trigger of their own, so when one closes focus goes back
  // to the button that opened it, once the dialog is out of the document.
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef<string | null>(null);
  const capture = useCallback((key: string, el: HTMLButtonElement | null): void => {
    if (el === null) openers.current.delete(key);
    else openers.current.set(key, el);
  }, []);
  useEffect(() => {
    if (dialog !== null || returnTo.current === null) return;
    const key = returnTo.current;
    returnTo.current = null;
    openers.current.get(key)?.focus();
  }, [dialog]);

  const issue = ({ body, label }: Issue): void => {
    const before = detail.run;
    command.mutate(
      { id: detail.run.id, body },
      {
        onSuccess: (updated) => {
          if (body.command === 'accept' || body.command === 'edit' || body.command === 'reject')
            changed.mark(body.field);
          const phrase =
            body.command === 'acceptClean'
              ? acceptCleanPhrase(before, updated.run)
              : body.command === 'approve'
                ? approvedPhrase(updated)
                : body.command === 'retry'
                  ? retriedPhrase(updated)
                  : decisionPhrase(label, body.command);
          log.record('good', `${phrase} ${resultSuffix()}`);
          // A retry of a Failed run is a fresh run; the page opens on it.
          if (updated.run.id !== detail.run.id)
            void navigate({ to: '/documents/extraction/$id', params: { id: updated.run.id } });
        },
        onError: (error) =>
          log.record('bad', `${label}: ${plainWords(describeExtractionError(error))}`),
      },
    );
  };

  const open = (next: Dialog, key: string): void => {
    returnTo.current = key;
    setDialog(next);
  };

  const activeField = hovered ?? selected;
  const active =
    activeField === null ? null : (values.find((v) => v.field === activeField) ?? null);
  const layout = detail.pages.find((p) => p.number === pageNumber) ?? detail.pages[0] ?? null;
  const highlight =
    active !== null && layout !== null && active.page === layout.number
      ? findQuote(layout, active.quote)
      : [];
  const showPage = (n: number): void => {
    if (n === layout?.number) return;
    setSwapped(!reduced);
    setPageNumber(n);
  };
  useEffect(() => {
    const box = frame.current;
    if (pick === 0 || box === null) return;
    const mark = box.querySelector('[data-testid="run-page-highlight"]');
    // jsdom lays nothing out and has no scrollTo; the page then stays where it is.
    if (mark === null || typeof box.scrollTo !== 'function') return;
    // Only the frame scrolls, so the table the reader picked from stays where it was. Smooth
    // only for this explicit pick, and never under reduced motion (docs/06 section 5).
    const top = mark.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({
      top: Math.max(0, top - box.clientHeight / 3),
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [pick, reduced]);
  const blocker = approveBlocker(detail.values);
  const decidedLine = sharedDecision(values);
  const actionsShown = offered && gates.reviewable;
  const cleanLeft = undecidedClean(detail.values);
  const accepted = detail.values.filter((v) => v.decision === 'accepted').length;
  const edited = detail.values.filter((v) => v.decision === 'edited').length;

  return (
    <>
      <Banner detail={detail} />
      <RunDetails detail={detail} />
      <Tiles detail={detail} />
      {detail.run.state === 'Failed' || detail.run.state === 'NeedsRetry' ? (
        <Card tone="error" testId="run-failed">
          <SectionHeader>
            {detail.run.state === 'Failed' ? 'The run failed' : 'The run needs a retry'}
          </SectionHeader>
          <p>
            {detail.run.errorCode === null
              ? 'No error code was recorded.'
              : `Error ${detail.run.errorCode}${detail.run.errorKind === null ? '' : ` (${detail.run.errorKind})`}.`}{' '}
            Retries taken: {detail.run.schemaRetries} schema, {detail.run.transientRetries}{' '}
            transient. Nothing of a failed run is staged; a data exception was opened for a person.
          </p>
          {offered ? (
            <Button
              size="small"
              appearance="primary"
              disabledFocusable={!gates.retryable || busy}
              onClick={() => issue({ body: { command: 'retry' }, label: 'Retry' })}
            >
              Retry
            </Button>
          ) : null}
        </Card>
      ) : null}
      <Card testId="run-review">
        <SectionHeader aside={`${plural(values.length, 'value')}, flagged and invalid first`}>
          Review
        </SectionHeader>
        {!offered ? (
          <p className="pb-meta" data-testid="run-read-only">
            {REVIEW_READ_ONLY}
          </p>
        ) : (
          <Toolbar
            end={
              <>
                <Button
                  size="small"
                  appearance="outline"
                  disabledFocusable={!gates.reviewable || busy}
                  title={
                    gates.blocked ??
                    (!traits.narrative
                      ? cleanLeft === 0
                        ? 'Every clean value is decided'
                        : `Accepts ${plural(cleanLeft, 'undecided clean value')}`
                      : cleanLeft === 0
                        ? 'Every clean value is decided; this also accepts the drafted highlights and commentary'
                        : `Accepts ${plural(cleanLeft, 'undecided clean value')} and the drafted narrative`)
                  }
                  onClick={() =>
                    issue({ body: { command: 'acceptClean' }, label: 'Accept clean values' })
                  }
                >
                  Accept clean values
                </Button>
                <Button
                  ref={(el) => capture('approve', el)}
                  size="small"
                  appearance="primary"
                  disabledFocusable={!gates.reviewable || busy || blocker !== null}
                  {...((gates.blocked ?? blocker) === null
                    ? {}
                    : { title: gates.blocked ?? blocker ?? '' })}
                  onClick={() => open({ kind: 'approve' }, 'approve')}
                >
                  {approveLabel}
                </Button>
                <SimulatedBadge />
              </>
            }
          >
            <p className="pb-meta">
              {traits.promotes
                ? 'Accept, edit or reject each flagged or invalid value, accept the clean ones in one go, then approve: the accepted and edited values are promoted into the quarter on record with their source.'
                : 'Accept, edit or reject each flagged or invalid value, accept the clean ones in one go, then approve. Approving a statement writes nothing to the quarterly record.'}
            </p>
          </Toolbar>
        )}
        {readAs === null ? null : (
          <p className="pb-notice" data-testid="run-read-as">
            {detail.run.approvedBy === null ? 'Once approved, this is read as: ' : 'Read as: '}
            <strong>{readAs}</strong>.
          </p>
        )}
        {runOutcome === null ? null : (
          <SuggestionOutcome outcome={runOutcome} statement={!traits.promotes} />
        )}
        {suggested.isError &&
        !(suggested.error instanceof ApiError && suggested.error.status === 404) ? (
          <p className="pb-notice pb-notice-bad" data-testid="run-suggestion-unavailable">
            Whether this approval suggested a mark could not be read. The Suggestions tab under
            Valuations lists what is open.
          </p>
        ) : null}
        <ActionStatus latest={log.latest} testId="run-action-status" />
        {values.length === 0 || !offered || gates.reviewable ? null : (
          <p className="pb-note pb-extraction-above" data-testid="run-blocked">
            {gates.blocked}.
          </p>
        )}
        {values.length === 0 || decidedLine === null ? null : (
          <p className="pb-note pb-extraction-above" data-testid="run-decided">
            {decidedLine}
          </p>
        )}
        {values.length === 0 ? (
          <EmptyState
            title="No values staged"
            detail={
              detail.run.state === 'Succeeded'
                ? traits.promotes
                  ? 'The run succeeded without values; nothing can be promoted from it.'
                  : 'The run succeeded without values; there is nothing to approve.'
                : 'Values are staged when a run succeeds; this one has none.'
            }
            testId="run-no-values"
          />
        ) : (
          <ValuesTable
            values={values}
            active={activeField}
            reviewable={gates.reviewable}
            blocked={gates.blocked}
            busy={busy}
            actionsShown={actionsShown}
            decidedOnce={decidedLine !== null}
            onHover={setHovered}
            onShow={(v) => {
              setSelected(v.field);
              if (v.page !== null) showPage(v.page);
              setPick((n) => n + 1);
            }}
            onAccept={(v) => issue({ body: { command: 'accept', field: v.field }, label: v.label })}
            onEdit={(v) => open({ kind: 'edit', value: v }, `edit:${v.field}`)}
            onReject={(v) =>
              open({ kind: 'reject', field: v.field, label: v.label }, `reject:${v.field}`)
            }
            capture={capture}
            rowProps={changed.rowProps}
          />
        )}
      </Card>
      <Card testId="run-page">
        <SectionHeader aside={plural(detail.pages.length, 'page')}>Document page</SectionHeader>
        {layout === null ? (
          <EmptyState
            title="No page layout"
            detail="The document's pages could not be read for this run."
          />
        ) : (
          <>
            <Toolbar>
              <Field>
                <Label htmlFor={pageSelectId}>Page</Label>
                <Dropdown
                  id={pageSelectId}
                  className="pb-extraction-filter"
                  data-testid="run-page-select"
                  value={`Page ${layout.number}`}
                  selectedOptions={[String(layout.number)]}
                  onOptionSelect={(_e, d) => {
                    const n = Number(d.optionValue);
                    if (Number.isInteger(n)) showPage(n);
                  }}
                >
                  {detail.pages.map((p) => (
                    <Option key={p.number} value={String(p.number)}>
                      {`Page ${p.number}`}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <p className="pb-meta" data-testid="run-page-note">
                {active === null
                  ? 'Choose a value’s page in the table to see its quote on the page.'
                  : active.page !== layout.number
                    ? `${active.label} is cited on ${active.page === null ? 'no page' : `page ${active.page}`}.`
                    : highlight.length === 0
                      ? `The quote of ${active.label} was not found on page ${layout.number}.`
                      : `Highlighting the quote of ${active.label} on page ${layout.number}.`}
              </p>
            </Toolbar>
            <div
              ref={frame}
              className="pb-extraction-page-frame"
              role="region"
              aria-label={`Page ${layout.number} of ${detail.run.fileName}`}
              tabIndex={0}
            >
              <div key={layout.number} className={swapped ? 'pb-swap-in' : undefined}>
                <PageView
                  page={layout}
                  highlight={highlight}
                  label={`Page ${layout.number} of ${detail.run.fileName}, drawn from its text`}
                />
              </div>
            </div>
          </>
        )}
      </Card>
      {traits.narrative ? (
        <NarrativeCard
          detail={detail}
          reviewable={gates.reviewable}
          blocked={gates.blocked}
          busy={busy}
          offered={offered}
          onIssue={issue}
          capture={capture}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <EditValueDialog
          value={dialog.value}
          onCancel={() => setDialog(null)}
          onSubmit={(body) => {
            issue({ body, label: dialog.value.label });
            setDialog(null);
          }}
        />
      ) : dialog?.kind === 'reject' ? (
        <ReasonDialog
          title="Reject"
          subject={`${dialog.label} of ${detail.run.fileName}`}
          onCancel={() => setDialog(null)}
          onSubmit={(reason) => {
            issue({
              body: { command: 'reject', field: dialog.field, reason },
              label: dialog.label,
            });
            setDialog(null);
          }}
        />
      ) : dialog?.kind === 'approve' ? (
        <ApproveDialog
          subject={`${plural(accepted, 'accepted value')} and ${plural(edited, 'edited value')} of ${detail.run.companyName ?? detail.run.fileName}, ${formatDate(promotedPeriod(detail))}`}
          readAs={readAs}
          onCancel={() => setDialog(null)}
          onSubmit={(reason) => {
            issue({
              body: reason === undefined ? { command: 'approve' } : { command: 'approve', reason },
              label: approveLabel,
            });
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One extraction run (docs/04 M4, docs/18 section 7): the staged values with their citations,
 * confidence, validation and decisions, flagged and invalid first; the page they were read from,
 * drawn from its text with the quote under review highlighted (click-to-source, I1); the drafted
 * narrative; and the commands the signed-in roles may issue, up to the approval that promotes.
 * A capital account statement (a schema with no record figure and no narrative, decision 0023)
 * shows how its lines will be read (our account for a position, or in a fund), has no narrative
 * card, and its approval promotes nothing.
 */
export function ExtractionRunPage(): ReactNode {
  const { id } = useParams({ from: '/app/documents/extraction/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(extractionRunQuery(id));
  // The roles decide what the review card says, so nothing is said until they are known.
  if (q.isPending || me.isPending) return <PageSkeleton tiles={5} rows={8} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <Breadcrumbs items={CRUMBS} />
        {missing ? (
          <ErrorState
            title="Extraction run not found or not visible to you"
            detail="There is no extraction run with this id in your view."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This extraction run"
            forbidden={EXTRACTION_FORBIDDEN}
            errorTitle="Extraction run unavailable"
            testId="run-unavailable"
          />
        )}
      </>
    );
  }
  return <RunBody key={q.data.run.id} detail={q.data} roles={me.data?.roles ?? []} />;
}
