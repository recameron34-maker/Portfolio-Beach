import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import { underwritingMetric } from '@pb/contracts';
import type {
  UnderwritingCaseVersion,
  UnderwritingCommandBody,
  UnderwritingComparison,
  UnderwritingRead,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { describeActionError } from '../../app/mutations.js';
import { meQuery } from '../../app/queries.js';
import { LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  KeyValueTable,
  NumCell,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
import { ActionStatus, ReasonDialog } from '../../components/WorkflowActions.js';
import { resultSuffix, useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMultiple,
  formatPct,
  MISSING,
  moneyLabel,
} from '../../lib/format.js';
import { balanceTiles } from '../../lib/tiles.js';
import { documentHref } from './data.js';
import { HubLink } from './parts.js';
import {
  byLine,
  CARD_TITLE,
  caseActions,
  caseStateTone,
  comparableVersions,
  DRAFT_ONLY,
  draftLabel,
  driverRows,
  irrTile,
  METRIC_LABEL,
  metricTile,
  moicTile,
  NO_CASE,
  NO_STANDING_CASE,
  OWN_FIGURES,
  PLAN_STATUS_LABEL,
  planChart,
  planStatusTone,
  progressNotes,
  sourcePlace,
  STALE_CASE,
  STRAIGHT_LINE_NOTE,
  VERSION_GONE,
  VERSION_NOT_COMPARED,
  versionLabels,
  YIELD_NOTE,
  yieldTiles,
} from './underwriting.js';
import type { PlanMetric, PlanProgress, PlanTile } from './underwriting.js';
import { isStaleCase, underwritingQuery, useUnderwritingCommand } from './underwriting-api.js';
import { draftOf, emptyDraft } from './underwriting-form.js';
import { UnderwritingForm } from './UnderwritingForm.js';
import './deal.css';

const METRICS: readonly PlanMetric[] = underwritingMetric.options;

/**
 * The figures against plan, EBITDA first: the three company figures, our IRR and our MOIC. A loan
 * is judged on its IRR alone: its tiles are the IRR and the MOIC, then its yield to maturity
 * beside the yield and the loss rate it was underwritten on, none of the three badged.
 */
function Tiles({
  comparison,
  compared,
}: {
  comparison: UnderwritingComparison;
  compared: UnderwritingCaseVersion;
}): ReactNode {
  const tiles: PlanTile[] =
    compared.form === 'credit'
      ? [
          irrTile(comparison.returns, compared.grossIrr),
          moicTile(comparison.returns, compared.grossMoic, 'repayment'),
          ...yieldTiles(comparison.yieldToMaturity, compared),
        ]
      : [
          ...comparison.metrics.map(metricTile),
          irrTile(comparison.returns, compared.grossIrr),
          moicTile(comparison.returns, compared.grossMoic),
        ];
  return (
    <div
      ref={balanceTiles}
      className="pb-tiles pb-deal-tiles pb-deal-aligned"
      data-testid="deal-underwriting-tiles"
    >
      {tiles.map((tile) => (
        <StatTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          hint={tile.hint}
          figure={
            tile.status === null ? undefined : (
              <Badge tone={planStatusTone(tile.status)}>{PLAN_STATUS_LABEL[tile.status]}</Badge>
            )
          }
        />
      ))}
    </div>
  );
}

/** Actual and plan for one metric by date, with the picker that chooses the metric. */
function PlanLines({
  comparison,
  company,
}: {
  comparison: UnderwritingComparison;
  company: string;
}): ReactNode {
  const pickerId = useId();
  const [metric, setMetric] = useState<PlanMetric>('ebitda');
  const series = comparison.series.find((s) => s.metric === metric);
  const last = series?.points[series.points.length - 1];
  if (series === undefined || last === undefined) {
    return <p className="pb-meta pb-deal-note">No plan dates or approved quarters to chart.</p>;
  }
  const label = METRIC_LABEL[metric];
  const chart = planChart(series);
  const row = comparison.metrics.find((m) => m.metric === metric);
  const now =
    comparison.quarter === null || row === undefined
      ? ''
      : ` At ${formatDate(comparison.quarter)} the actual is ${formatMoneyM(row.actual)} against a plan of ${formatMoneyM(row.plan)}.`;
  return (
    <div className="pb-deal-gap">
      <Toolbar>
        <Field>
          <Label htmlFor={pickerId}>Metric</Label>
          <Dropdown
            id={pickerId}
            value={label}
            selectedOptions={[metric]}
            onOptionSelect={(_e, d) => {
              const picked = METRICS.find((m) => m === d.optionValue);
              if (picked !== undefined) setMetric(picked);
            }}
          >
            {METRICS.map((m) => (
              <Option key={m} value={m}>
                {METRIC_LABEL[m]}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </Toolbar>
      <LineChart
        title={`${label}, actual and plan`}
        subtitle="Approved quarters and plan dates"
        x={chart.x}
        at={chart.at}
        series={[
          { name: 'Actual', values: chart.actual },
          { name: 'Plan', values: chart.plan },
        ]}
        kind="money"
        format={moneyLabel}
        summary={`${label} of ${company} against the base case over ${chart.x.length} dates to ${formatDate(last.periodEnd)}.${now}`}
        testId="deal-underwriting-chart"
      />
      <p className="pb-meta pb-deal-note">{STRAIGHT_LINE_NOTE}</p>
    </div>
  );
}

/** The planned bridge to exit, what has been earned of it and the share, with the time that has passed. */
function Drivers({ progress }: { progress: PlanProgress }): ReactNode {
  const rows = driverRows(progress);
  const body = rows.filter((r) => r.key !== 'total');
  const total = rows.find((r) => r.key === 'total');
  const notes = progressNotes(progress);
  return (
    <div className="pb-deal-gap" data-testid="deal-underwriting-drivers">
      <TableWrap label="Value creation against plan">
        <table className="pb-table pb-deal-totals" aria-label="Value creation against plan">
          <thead>
            <tr>
              <th>Driver</th>
              <th className="num">Planned to exit</th>
              <th className="num">Earned to date</th>
              <th className="num">Progress</th>
            </tr>
          </thead>
          <tbody>
            {body.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <NumCell>{r.planned}</NumCell>
                <NumCell>{r.earned}</NumCell>
                <NumCell>{r.progress}</NumCell>
              </tr>
            ))}
          </tbody>
          {total === undefined ? null : (
            <tfoot>
              <tr>
                <th scope="row">{total.label}</th>
                <NumCell>{total.planned}</NumCell>
                <NumCell>{total.earned}</NumCell>
                <NumCell>{total.progress}</NumCell>
              </tr>
            </tfoot>
          )}
        </table>
      </TableWrap>
      {notes.length === 0 ? null : <p className="pb-meta pb-deal-note">{notes.join(' ')}</p>}
    </div>
  );
}

/** Where the figures of a case come from: the document with the place in it, or the note on where the model is held. */
function SourceValue({ source }: { source: UnderwritingCaseVersion['source'] }): ReactNode {
  const place = sourcePlace(source);
  if (source.document !== null) {
    return (
      <>
        <HubLink href={documentHref(source.document.id)} testId="underwriting-source">
          {source.document.name}
        </HubLink>
        {place === null ? null : `, ${place}`}
      </>
    );
  }
  return source.note ?? MISSING;
}

/** The plan of an equity case as it was recorded, date by date. */
function PlanTable({
  version,
  label,
}: {
  version: UnderwritingCaseVersion;
  label: string;
}): ReactNode {
  if (version.points.length === 0) return null;
  return (
    <TableWrap label={label}>
      <table className="pb-table" aria-label={label}>
        <thead>
          <tr>
            <th>Twelve months ending</th>
            <th className="num">Revenue</th>
            <th className="num">EBITDA</th>
            <th className="num">Net debt</th>
          </tr>
        </thead>
        <tbody>
          {version.points.map((p) => (
            <tr key={p.periodEnd}>
              <td className="pb-nowrap">{formatDate(p.periodEnd)}</td>
              <NumCell>{formatMoneyM(p.revenueLtm)}</NumCell>
              <NumCell>{formatMoneyM(p.ebitdaLtm)}</NumCell>
              <NumCell>{formatMoneyM(p.netDebt)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** One version of the case: its terms, who entered and confirmed it, its source and its plan. */
export function CaseBlock({
  version,
  label,
  testId,
  children,
}: {
  version: UnderwritingCaseVersion;
  label: string;
  testId: string;
  /** What the reader may do to this version, under its terms and its plan. */
  children?: ReactNode;
}): ReactNode {
  const loan = version.form === 'credit';
  const terms = (
    <KeyValueTable
      label={`${label}, terms`}
      // A loan has no plan beside its terms, so they take the width in two columns.
      columns={loan ? 2 : 1}
      rows={[
        { label: 'Case date', value: formatDate(version.caseDate) },
        ...(loan
          ? [
              { label: 'Expected repayment', value: formatDate(version.plannedExitDate) },
              { label: 'Underwritten yield', value: formatPct(version.underwrittenYield, 2) },
              { label: 'Annual loss rate', value: formatPct(version.annualLossRate, 2) },
            ]
          : [
              { label: 'Planned exit', value: formatDate(version.plannedExitDate) },
              { label: 'Exit multiple', value: formatMultiple(version.exitMultiple) },
            ]),
        { label: 'Underwritten gross MOIC', value: formatMoic(version.grossMoic) },
        { label: 'Underwritten gross IRR', value: formatPct(version.grossIrr) },
        { label: 'Entered by', value: byLine(version.enteredBy, version.enteredAt) },
        { label: 'Confirmed by', value: byLine(version.confirmedBy, version.confirmedAt) },
        { label: 'Source', value: <SourceValue source={version.source} /> },
        ...(version.note === null ? [] : [{ label: 'Note', value: version.note }]),
        ...(version.revisionReason === null
          ? []
          : [{ label: 'Reason for the revision', value: version.revisionReason }]),
        ...(version.withdrawnReason === null
          ? []
          : [{ label: 'Reason it was withdrawn', value: version.withdrawnReason }]),
      ]}
    />
  );
  return (
    <div className="pb-deal-gap" data-testid={testId}>
      <h3 className="pb-deal-subhead">
        {label}
        <Badge tone={caseStateTone(version.state)}>{version.state}</Badge>
      </h3>
      {loan ? (
        terms
      ) : (
        <div className="pb-deal-split">
          <div>{terms}</div>
          <div>
            <PlanTable version={version} label={`${label}, plan`} />
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

/** Every version on record, oldest first: what each is, where it stands and why it was revised or withdrawn. */
function Versions({
  versions,
  labels,
  shown,
}: {
  versions: readonly UnderwritingCaseVersion[];
  labels: ReadonlyMap<number, string>;
  /** The versions the card already shows in full: alone, one of them needs no list. */
  shown: readonly (UnderwritingCaseVersion | undefined)[];
}): ReactNode {
  if (versions.every((v) => shown.includes(v)) && versions.length < 2) return null;
  return (
    <div className="pb-deal-gap" data-testid="deal-underwriting-versions">
      <TableWrap label="Versions of the base case">
        <table className="pb-table" aria-label="Versions of the base case">
          <thead>
            <tr>
              <th className="num">Version</th>
              <th>Case</th>
              <th>State</th>
              <th>Case date</th>
              <th>Entered by</th>
              <th>Confirmed by</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <NumCell>{String(v.version)}</NumCell>
                <td>{labels.get(v.version) ?? MISSING}</td>
                <td>
                  <Badge tone={caseStateTone(v.state)}>{v.state}</Badge>
                </td>
                <td className="pb-nowrap">{formatDate(v.caseDate)}</td>
                <td>{byLine(v.enteredBy, v.enteredAt)}</td>
                <td>{byLine(v.confirmedBy, v.confirmedAt)}</td>
                <td>{v.withdrawnReason ?? v.revisionReason ?? MISSING}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

/** The picker of the version the position is compared with, shown once there is more than one to pick. */
function VersionPicker({
  data,
  labels,
  onPick,
}: {
  data: UnderwritingRead;
  labels: ReadonlyMap<number, string>;
  onPick: (version: number) => void;
}): ReactNode {
  const pickerId = useId();
  const options = comparableVersions(data.versions);
  if (options.length < 2 || data.comparedVersion === null) return null;
  return (
    <Toolbar>
      <Field>
        <Label htmlFor={pickerId}>Compared with</Label>
        <Dropdown
          id={pickerId}
          className="pb-deal-version-picker"
          value={labels.get(data.comparedVersion) ?? ''}
          selectedOptions={[String(data.comparedVersion)]}
          onOptionSelect={(_e, d) => {
            const picked = options.find((v) => String(v.version) === d.optionValue);
            if (picked !== undefined) onPick(picked.version);
          }}
        >
          {options.map((v) => (
            <Option key={v.version} value={String(v.version)}>
              {labels.get(v.version) ?? ''}
            </Option>
          ))}
        </Dropdown>
      </Field>
    </Toolbar>
  );
}

/** What the form is open for: a first case, a revision of the Confirmed case shown, or the Draft that waits. */
type FormMode =
  | { kind: 'record' }
  | { kind: 'revise'; from: UnderwritingCaseVersion }
  | { kind: 'edit'; draft: UnderwritingCaseVersion };

const FORM_TITLE: Readonly<Record<FormMode['kind'], string>> = {
  record: 'Record the base case',
  revise: 'Revise the base case',
  edit: 'Edit the draft',
};

/** The buttons of the card that open something or take themselves away, by what they do. */
type ButtonKey = FormMode['kind'] | 'confirm' | 'withdraw' | 'retire';

/**
 * Keyboard focus on the card. Every step takes away the button that was just used, and focus
 * would fall to the page, so a keyboard or screen-reader user would lose their place. The form
 * takes focus itself when it opens. When the form or the reason dialog closes (the overlay),
 * focus goes back to the button that opened it, or to the card's title when that button is busy
 * or about to go (a save, a command sent). And when a button leaves the card while it holds
 * focus (a confirmation takes the Draft and its buttons away), the title takes it. Focus the
 * reader has moved elsewhere is left alone.
 */
function useCardFocus(
  overlay: boolean,
  arrivingRef: MutableRefObject<boolean>,
): {
  titleRef: RefObject<HTMLSpanElement | null>;
  /** Called from the ref of each button, so the card knows where it is and when it leaves. */
  capture: (key: ButtonKey, el: HTMLButtonElement | null) => void;
  /** Where focus goes once the overlay has closed. */
  returnTo: (to: ButtonKey | 'title') => void;
} {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const buttonsRef = useRef(new Map<ButtonKey, HTMLButtonElement>());
  const orphanedRef = useRef(false);
  const returnToRef = useRef<ButtonKey | 'title' | null>(null);
  const capture = useCallback((key: ButtonKey, el: HTMLButtonElement | null): void => {
    if (el !== null) {
      buttonsRef.current.set(key, el);
      return;
    }
    // A ref is released before its element leaves the page, so focus can still be asked.
    if (buttonsRef.current.get(key) === document.activeElement) orphanedRef.current = true;
    buttonsRef.current.delete(key);
  }, []);
  const returnTo = useCallback((to: ButtonKey | 'title'): void => {
    returnToRef.current = to;
  }, []);
  useEffect(() => {
    if (overlay || returnToRef.current === null) return;
    const to = returnToRef.current;
    returnToRef.current = null;
    const opener = to === 'title' ? undefined : buttonsRef.current.get(to);
    if (opener !== undefined && !opener.disabled) opener.focus();
    else titleRef.current?.focus();
  }, [overlay]);
  useEffect(() => {
    const lost = orphanedRef.current || arrivingRef.current;
    orphanedRef.current = false;
    arrivingRef.current = false;
    if (!lost || overlay) return;
    const active = document.activeElement;
    if (active === null || active === document.body) titleRef.current?.focus();
  });
  return { titleRef, capture, returnTo };
}

/** The button that opens the form in each mode: where focus returns when the form is cancelled. */
const OPENER: Readonly<Record<FormMode['kind'], ButtonKey>> = {
  record: 'record',
  revise: 'revise',
  edit: 'edit',
};

/** A command that needs a reason before it is sent: the Draft withdrawn, or a Confirmed case retired. */
interface ReasonFor {
  command: 'withdraw' | 'retire';
  version: UnderwritingCaseVersion;
}

const REASON_DIALOG: Readonly<Record<ReasonFor['command'], { title: string; subject: string }>> = {
  withdraw: {
    title: 'Withdraw draft',
    subject: 'The draft stays on record as withdrawn, with your reason.',
  },
  retire: {
    title: 'Retire',
    subject:
      'For a base case confirmed in error. It stays on record as withdrawn; a change to the plan is a revision instead.',
  },
};

/**
 * The card once the read has answered for a position that holds a base case: the comparison,
 * the versions, and what the reader may do. The deal team records a Draft, edits or withdraws it
 * and revises a Confirmed case; a second person confirms; an approver retires a case confirmed
 * in error; everyone else reads. The form takes the card's place while it is open, and the
 * result of every action stays in the card's one status region.
 */
function CaseCard({
  id,
  company,
  data,
  log,
  pickGone,
  arrivingRef,
  onPick,
}: {
  id: string;
  company: string;
  data: UnderwritingRead;
  /** The results of what the reader did, kept by the card above so they outlive every refresh. */
  log: ActionLog;
  /** The version the reader had picked stands no longer, so the card is back on the default case. */
  pickGone: boolean;
  /** Set when the reader came here by a button that has just left the page: the title takes focus. */
  arrivingRef: MutableRefObject<boolean>;
  onPick: (version: number) => void;
}): ReactNode {
  const me = useQuery(meQuery);
  const command = useUnderwritingCommand(id);
  const [form, setForm] = useState<FormMode | null>(null);
  const [reasonFor, setReasonFor] = useState<ReasonFor | null>(null);

  const overlay = form !== null || reasonFor !== null;
  const { titleRef, capture, returnTo } = useCardFocus(overlay, arrivingRef);
  const closeForm = (to: ButtonKey | 'title'): void => {
    returnTo(to);
    setForm(null);
  };
  // The card is only shown for a position that holds a base case, so the read names its form.
  const caseForm = data.form ?? 'equity';
  const labels = versionLabels(data.versions);
  const compared = data.versions.find((v) => v.version === data.comparedVersion);
  const draft = data.versions.find((v) => v.state === 'Draft');
  const comparison = data.comparison;
  const quarter = comparison?.quarter ?? null;
  const actions = caseActions({
    roles: me.data?.roles ?? [],
    userId: me.data?.userId ?? null,
    draft,
    shown: compared,
    standing: data.versions.some((v) => v.state === 'Confirmed'),
  });
  const busy = command.isPending;

  /** A refusal in the card's words; a case somebody changed meanwhile closes the form, since the read is refreshed. */
  const failed = (what: string, error: unknown): void => {
    if (isStaleCase(error)) {
      if (form !== null) closeForm('title');
      log.record('bad', STALE_CASE);
    } else log.record('bad', `${what}: ${describeActionError(error)}`);
  };
  const send = (
    what: string,
    version: UnderwritingCaseVersion,
    body: UnderwritingCommandBody,
    done: string,
  ): void =>
    command.mutate(
      { id: version.id, rowVersion: version.rowVersion, body },
      {
        onSuccess: () => log.record('good', `${done} ${resultSuffix()}`),
        onError: (error) => failed(what, error),
      },
    );

  const header = (
    <SectionHeader
      aside={
        quarter === null ? `As of ${formatDate(data.asOf)}` : `Quarter ended ${formatDate(quarter)}`
      }
    >
      <span ref={titleRef} tabIndex={-1}>
        {CARD_TITLE}
      </span>
    </SectionHeader>
  );
  const status = (
    <>
      <ActionStatus latest={log.latest} testId="underwriting-action-status" />
      {pickGone ? (
        <p className="pb-meta pb-deal-note" data-testid="underwriting-version-gone">
          {VERSION_GONE}
        </p>
      ) : null}
    </>
  );

  if (form !== null) {
    const from = form.kind === 'record' ? undefined : form.kind === 'edit' ? form.draft : form.from;
    return (
      <Card testId="deal-underwriting">
        {header}
        {status}
        {form.kind === 'revise' ? (
          <p className="pb-meta pb-deal-note">
            Keep the case date to correct this case: the new version replaces it once confirmed. A
            later date records a re-underwriting, and both stay.
          </p>
        ) : null}
        <UnderwritingForm
          investmentId={id}
          form={caseForm}
          title={FORM_TITLE[form.kind]}
          initial={
            from === undefined ? emptyDraft() : draftOf(from, { keepReason: form.kind === 'edit' })
          }
          editing={
            form.kind === 'edit'
              ? { id: form.draft.id, rowVersion: form.draft.rowVersion }
              : undefined
          }
          needsReason={form.kind === 'edit' ? form.draft.version > 1 : data.versions.length > 0}
          sourceDocumentName={from?.source.document?.name}
          onSaved={() => {
            log.record(
              'good',
              `${form.kind === 'edit' ? 'Draft saved' : 'Draft recorded'}: a second person confirms it ${resultSuffix()}`,
            );
            // The button that opened the form is about to go with the refreshed read.
            closeForm('title');
          }}
          onFailed={(error) => failed(FORM_TITLE[form.kind], error)}
          onCancel={() => closeForm(OPENER[form.kind])}
        />
      </Card>
    );
  }

  return (
    <Card testId="deal-underwriting">
      {header}
      {status}
      {comparison !== null && compared !== undefined ? (
        <>
          <VersionPicker data={data} labels={labels} onPick={onPick} />
          <Tiles comparison={comparison} compared={compared} />
          {compared.form === 'credit' ? (
            // A loan has no company plan: no chart and no drivers, and its yields are not judged.
            <p className="pb-meta pb-deal-note" data-testid="deal-underwriting-yield-note">
              {YIELD_NOTE}
            </p>
          ) : (
            <>
              <PlanLines comparison={comparison} company={company} />
              {comparison.valueCreation === null ? null : (
                <Drivers progress={comparison.valueCreation} />
              )}
            </>
          )}
          <CaseBlock
            version={compared}
            label={labels.get(compared.version) ?? 'Base case'}
            testId="deal-underwriting-case"
          >
            {actions.revise || actions.retire ? (
              <div className="pb-deal-actions">
                {actions.revise ? (
                  <Button
                    ref={(el) => capture('revise', el)}
                    size="small"
                    onClick={() => setForm({ kind: 'revise', from: compared })}
                  >
                    Revise
                  </Button>
                ) : null}
                {actions.retire ? (
                  <Button
                    ref={(el) => capture('retire', el)}
                    size="small"
                    disabled={busy}
                    onClick={() => setReasonFor({ command: 'retire', version: compared })}
                  >
                    Retire
                  </Button>
                ) : null}
                <SimulatedBadge />
              </div>
            ) : null}
          </CaseBlock>
        </>
      ) : data.versions.length === 0 ? (
        <EmptyState
          title={NO_CASE}
          detail="The deal team records the sponsor's base case, and a second person confirms it."
          testId="deal-underwriting-empty"
        />
      ) : (
        // Beside the versions under it, the state of the card is one quiet line.
        <p className="pb-meta" data-testid="deal-underwriting-empty">
          {draft === undefined ? NO_STANDING_CASE : DRAFT_ONLY}
        </p>
      )}
      {actions.record ? (
        <div className="pb-deal-actions">
          <Button
            ref={(el) => capture('record', el)}
            appearance="primary"
            size="small"
            onClick={() => setForm({ kind: 'record' })}
          >
            Record base case
          </Button>
          <SimulatedBadge />
        </div>
      ) : null}
      {draft === undefined ? null : (
        <CaseBlock version={draft} label={draftLabel(draft)} testId="deal-underwriting-draft">
          {actions.editDraft || actions.withdrawDraft || actions.confirm === 'offer' ? (
            <div className="pb-deal-actions">
              {actions.confirm === 'offer' ? (
                <Button
                  ref={(el) => capture('confirm', el)}
                  appearance="primary"
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    send(
                      'Confirm',
                      draft,
                      { command: 'confirm' },
                      draft.kind === 'correction'
                        ? 'Correction confirmed: it replaces the case it corrects'
                        : 'Base case confirmed',
                    )
                  }
                >
                  Confirm
                </Button>
              ) : null}
              {actions.editDraft ? (
                <Button
                  ref={(el) => capture('edit', el)}
                  size="small"
                  disabled={busy}
                  onClick={() => setForm({ kind: 'edit', draft })}
                >
                  Edit draft
                </Button>
              ) : null}
              {actions.withdrawDraft ? (
                <Button
                  ref={(el) => capture('withdraw', el)}
                  size="small"
                  disabled={busy}
                  onClick={() => setReasonFor({ command: 'withdraw', version: draft })}
                >
                  Withdraw draft
                </Button>
              ) : null}
              <SimulatedBadge />
            </div>
          ) : null}
          {actions.confirm === 'own_figures' ? (
            <p className="pb-meta pb-deal-note" data-testid="underwriting-own-figures">
              {OWN_FIGURES}
            </p>
          ) : null}
        </CaseBlock>
      )}
      <Versions versions={data.versions} labels={labels} shown={[compared, draft]} />
      {reasonFor === null ? null : (
        <ReasonDialog
          title={REASON_DIALOG[reasonFor.command].title}
          subject={REASON_DIALOG[reasonFor.command].subject}
          onCancel={() => {
            returnTo(reasonFor.command);
            setReasonFor(null);
          }}
          onSubmit={(reason) => {
            const { command: name, version } = reasonFor;
            // The button that asked for the reason is busy now, and gone once the command lands.
            returnTo('title');
            setReasonFor(null);
            send(
              REASON_DIALOG[name].title,
              version,
              { command: name, reason },
              name === 'withdraw' ? 'Draft withdrawn' : 'Base case retired',
            );
          }}
        />
      )}
    </Card>
  );
}

/**
 * A position against the base case its sponsor underwrote: revenue, EBITDA and net debt of the
 * current quarter against plan at the same date, the share of the planned value creation earned
 * so far, and our gross IRR and MOIC against underwriting, each ahead of, on or behind plan. A
 * loan is judged on its gross IRR alone: its card shows the IRR and the MOIC against
 * underwriting, then its yield to maturity beside the yield and the loss rate it was underwritten
 * on, with no chart and no drivers. The position is compared with its entry case unless the
 * reader picks a later version. Only a case a second person confirmed is compared; a Draft is
 * shown as what it is. A position that holds no base case (a primary fund) has no card, and a
 * figure that is not calculable is the missing placeholder with its reason, never a zero.
 */
export function UnderwritingCard({ id, company }: { id: string; company: string }): ReactNode {
  // The version the reader picked; the entry case until they pick one.
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const [pickGone, setPickGone] = useState(false);
  // Kept here, above everything a refresh can replace, so the result of an action is never lost
  // with the part of the card that sent it.
  const log = useActionLog();
  const arrivingRef = useRef(false);
  const q = useQuery({ ...underwritingQuery(id, picked), placeholderData: keepPreviousData });
  const notFound = q.isError && q.error instanceof ApiError && q.error.status === 404;
  // A version that was shown and stands no longer (retired here, or by somebody else meanwhile)
  // answers not found when the read is refreshed: the card goes back to the case the position
  // is compared with by default, and says so, instead of ending on a notice.
  // (State adjusted while rendering: the next render has no pick, so this runs once.)
  if (notFound && picked !== undefined && q.data !== undefined) {
    setPicked(undefined);
    setPickGone(true);
  }
  const pick = (version: number | undefined): void => {
    setPickGone(false);
    setPicked(version);
  };
  // Not found for the position itself means there is nothing of it to show; the workspace says so.
  if (notFound && picked === undefined) return null;
  if (q.data === undefined) {
    if (q.isPending) {
      return (
        <Card testId="deal-underwriting-loading">
          <PageSkeleton rows={3} />
        </Card>
      );
    }
    // The read failed before it ever answered. A read that fails later keeps the card, and a
    // form open on it, as they are (the convention of the other tabs of the workspace).
    return (
      <Card testId="deal-underwriting">
        <SectionHeader>{CARD_TITLE}</SectionHeader>
        <ActionStatus latest={log.latest} testId="underwriting-action-status" />
        {notFound ? (
          <>
            <p className="pb-notice pb-notice-bad">{VERSION_NOT_COMPARED}</p>
            <Toolbar>
              <Button
                size="small"
                onClick={() => {
                  arrivingRef.current = true;
                  pick(undefined);
                }}
              >
                Show the entry case
              </Button>
            </Toolbar>
          </>
        ) : (
          <UnavailableState inline error={q.error} subject="The base case" />
        )}
      </Card>
    );
  }
  // A position that holds no base case: nothing to show, and nothing to record.
  if (q.data.form === null) return null;
  return (
    <CaseCard
      id={id}
      company={company}
      data={q.data}
      log={log}
      pickGone={pickGone}
      arrivingRef={arrivingRef}
      onPick={pick}
    />
  );
}
