import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import { underwritingMetric } from '@pb/contracts';
import type {
  UnderwritingCaseVersion,
  UnderwritingComparison,
  UnderwritingRead,
} from '@pb/contracts';
import { ApiError } from '../../api/client.js';
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
  StatTile,
  TableWrap,
  Toolbar,
} from '../../components/ui.js';
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
  PLAN_STATUS_LABEL,
  planChart,
  planStatusTone,
  progressNotes,
  sourcePlace,
  STRAIGHT_LINE_NOTE,
  versionLabels,
} from './underwriting.js';
import type { PlanMetric, PlanProgress, PlanTile } from './underwriting.js';
import { underwritingQuery } from './underwriting-api.js';
import './deal.css';

const METRICS: readonly PlanMetric[] = underwritingMetric.options;

/** The figures against plan, EBITDA first: the three company figures, our IRR and our MOIC. */
function Tiles({
  comparison,
  compared,
}: {
  comparison: UnderwritingComparison;
  compared: UnderwritingCaseVersion;
}): ReactNode {
  const tiles: PlanTile[] = [
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
}: {
  version: UnderwritingCaseVersion;
  label: string;
  testId: string;
}): ReactNode {
  const terms = `${label}, terms`;
  return (
    <div className="pb-deal-gap" data-testid={testId}>
      <h3 className="pb-deal-subhead">
        {label}
        <Badge tone={caseStateTone(version.state)}>{version.state}</Badge>
      </h3>
      <div className="pb-deal-split">
        <div>
          <KeyValueTable
            label={terms}
            columns={1}
            rows={[
              { label: 'Case date', value: formatDate(version.caseDate) },
              { label: 'Planned exit', value: formatDate(version.plannedExitDate) },
              { label: 'Exit multiple', value: formatMultiple(version.exitMultiple) },
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
        </div>
        <div>
          <PlanTable version={version} label={`${label}, plan`} />
        </div>
      </div>
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

/**
 * A position against the base case its sponsor underwrote: revenue, EBITDA and net debt of the
 * current quarter against plan at the same date, the share of the planned value creation earned
 * so far, and our gross IRR and MOIC against underwriting, each ahead of, on or behind plan. The
 * position is compared with its entry case unless the reader picks a later version. Only a case
 * a second person confirmed is compared; a Draft is shown as what it is. A position that holds
 * no base case (a primary fund) has no card, and a figure that is not calculable is the missing
 * placeholder with its reason, never a zero.
 */
export function UnderwritingCard({ id, company }: { id: string; company: string }): ReactNode {
  // The version the reader picked; the entry case until they pick one.
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const q = useQuery({ ...underwritingQuery(id, picked), placeholderData: keepPreviousData });
  if (q.isPending) {
    return (
      <Card testId="deal-underwriting-loading">
        <PageSkeleton rows={3} />
      </Card>
    );
  }
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    // Not found here means there is nothing of this position to show; the workspace says so itself.
    if (notFound && picked === undefined) return null;
    return (
      <Card testId="deal-underwriting">
        <SectionHeader>{CARD_TITLE}</SectionHeader>
        {notFound ? (
          <>
            <p className="pb-notice pb-notice-bad">
              That version of the base case is no longer one the position is compared with.
            </p>
            <Toolbar>
              <Button size="small" onClick={() => setPicked(undefined)}>
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
  const data = q.data;
  // A position that holds no base case: nothing to show, and nothing to record.
  if (data.form === null) return null;
  const labels = versionLabels(data.versions);
  const compared = data.versions.find((v) => v.version === data.comparedVersion);
  const draft = data.versions.find((v) => v.state === 'Draft');
  const comparison = data.comparison;
  const quarter = comparison?.quarter ?? null;
  return (
    <Card testId="deal-underwriting">
      <SectionHeader
        aside={
          quarter === null
            ? `As of ${formatDate(data.asOf)}`
            : `Quarter ended ${formatDate(quarter)}`
        }
      >
        {CARD_TITLE}
      </SectionHeader>
      {comparison !== null && compared !== undefined ? (
        <>
          <VersionPicker data={data} labels={labels} onPick={setPicked} />
          <Tiles comparison={comparison} compared={compared} />
          <PlanLines comparison={comparison} company={company} />
          {comparison.valueCreation === null ? null : (
            <Drivers progress={comparison.valueCreation} />
          )}
          <CaseBlock
            version={compared}
            label={labels.get(compared.version) ?? 'Base case'}
            testId="deal-underwriting-case"
          />
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
      {draft === undefined ? null : (
        <CaseBlock version={draft} label={draftLabel(draft)} testId="deal-underwriting-draft" />
      )}
      <Versions versions={data.versions} labels={labels} shown={[compared, draft]} />
    </Card>
  );
}
