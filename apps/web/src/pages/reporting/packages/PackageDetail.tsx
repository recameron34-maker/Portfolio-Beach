import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import type { QaFindingRow, ReportPackageContent, ReportPackageDetail } from '@pb/contracts';
import { ApiError } from '../../../api/client.js';
import { investmentsQuery, LIST_LIMIT } from '../../../app/queries.js';
import { UnavailableState } from '../../../components/UnavailableState.js';
import { StepStrip } from '../../../components/StepStrip.js';
import { ActionLogCard, ActionStatus } from '../../../components/WorkflowActions.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValueTable,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../../../components/ui.js';
import type { Tone } from '../../../components/ui.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  formatPct,
  formatQuarter,
  MISSING,
  plural,
} from '../../../lib/format.js';
import { useActionLog } from '../../../lib/workflow.js';
import { reportPackageQuery } from './api.js';
import {
  BASIS_WORDS,
  beginNavCell,
  changeLogRows,
  checksSummary,
  clientShareRows,
  endNavCell,
  entityWords,
  explanationRows,
  findingResult,
  findingValue,
  footnoteWords,
  gainLossCell,
  gateSteps,
  generatedBy,
  LABEL_WORDS,
  markCell,
  NET_NOTICE,
  NEXT_STEP_WORDS,
  overridesOf,
  positionNames,
  RESULT_WORDS,
  ruleWords,
  splitFindings,
  WHO_READS_PACKAGES,
} from './packages.js';
import type { FigureCell, FindingResult, PositionNames } from './packages.js';
import { PackageStateBadge } from './Packages.js';
import './packages.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-pkg-back">
      <Link to="/reporting/packages">Client packages</Link>
    </p>
  );
}

/** A person with the time they acted, or the missing placeholder while nobody has. */
function byAt(person: { name: string } | null, at: string | null): string {
  if (person === null) return MISSING;
  return at === null ? person.name : `${person.name}, ${formatDateTime(at)}`;
}

/**
 * The row header of a position: its number, which never breaks across lines, and the company
 * when the reader's own positions list has it.
 */
function PositionTh({
  positionRef,
  names,
}: {
  positionRef: string;
  names: PositionNames;
}): ReactNode {
  const name = names.get(positionRef);
  return (
    <th scope="row">
      <span className="pb-nowrap">{positionRef}</span>
      {name === undefined ? null : ` ${name}`}
    </th>
  );
}

/** What every card of a Draft reads: there are no figures and no checks until it is generated. */
function NotGenerated(): ReactNode {
  return <EmptyState title="Not generated yet" />;
}

/**
 * The release gate (docs/18 section 5): where the package stands among the six steps, what
 * happens next and who does it, who prepared, approved and released it, and once it is approved
 * the hash its content was locked with (SEC-9.3).
 */
function ReleaseGateCard({ detail }: { detail: ReportPackageDetail }): ReactNode {
  return (
    <Card testId="package-gate">
      <SectionHeader>Release gate</SectionHeader>
      <StepStrip label="Release gate" steps={gateSteps(detail)} />
      <p className="pb-pkg-next" data-testid="package-next">
        {NEXT_STEP_WORDS[detail.state]}
      </p>
      <KeyValueTable
        label="Who moved the package"
        rows={[
          { label: 'Prepared by', value: detail.preparedBy.name },
          { label: 'Checks', value: checksSummary(detail.qa) },
          { label: 'Approved by', value: byAt(detail.reviewer, detail.approvedAt) },
          { label: 'Released by', value: byAt(detail.releasedBy, detail.releasedAt) },
          ...(detail.correctionReason === null
            ? []
            : [{ label: 'Reason for this version', value: detail.correctionReason }]),
        ]}
      />
      {detail.contentHash === null ? null : (
        <p className="pb-pkg-hash" data-testid="package-hash">
          <span className="pb-pkg-hash-label">Content hash (SHA-256)</span>
          <span className="pb-key pb-pkg-hash-value">{detail.contentHash}</span>
          <span className="pb-meta">Taken over everything this package shows, as approved.</span>
        </p>
      )}
    </Card>
  );
}

/** A failed check is an alarm, an overridden one was accepted by a person, a passed one needs no badge. */
const RESULT_TONES: Readonly<Record<Exclude<FindingResult, 'passed'>, Tone>> = {
  failed: 'bad',
  overridden: 'watch',
};

function ResultCell({ finding }: { finding: QaFindingRow }): ReactNode {
  const result = findingResult(finding);
  return (
    <td>
      {result === 'passed' ? (
        RESULT_WORDS.passed
      ) : (
        <Badge tone={RESULT_TONES[result]}>{RESULT_WORDS[result]}</Badge>
      )}
    </td>
  );
}

/** What a check expected or found; the placeholder reads muted, as it does in every table. */
function ValueCell({
  finding,
  value,
  names,
}: {
  finding: QaFindingRow;
  value: string | null;
  names: PositionNames;
}): ReactNode {
  const text = findingValue(finding.rule, value, names);
  const kind = ruleWords(finding.rule).kind;
  // A list of positions wraps; a figure, a date or a label stays on one line.
  const className = [
    kind === 'positions' ? '' : 'pb-pkg-value',
    text === MISSING ? 'is-missing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <td {...(className === '' ? {} : { className })}>{text}</td>;
}

function ChecksTable({
  rows,
  names,
}: {
  rows: readonly QaFindingRow[];
  names: PositionNames;
}): ReactNode {
  return (
    <TableWrap label="Checks">
      <table className="pb-table" aria-label="Checks">
        <thead>
          <tr>
            <th>Result</th>
            <th>Check</th>
            <th>About</th>
            <th>Expected</th>
            <th>Found</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((finding) => (
            <tr key={finding.id}>
              <ResultCell finding={finding} />
              <td>{ruleWords(finding.rule).name}</td>
              <td>{entityWords(finding.rule, finding.entityRef, names)}</td>
              <ValueCell finding={finding} value={finding.expected} names={names} />
              <ValueCell finding={finding} value={finding.actual} names={names} />
              <td className="pb-pkg-detail">{finding.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * The findings of the latest run (docs/08 section 7): the checks that did not pass first, with
 * what each expected and what it found, and the ones that passed behind a toggle. An override
 * is said once, above the table: an approver gives one reason for every failed check of a run.
 */
function ChecksCard({
  detail,
  names,
}: {
  detail: ReportPackageDetail;
  names: PositionNames;
}): ReactNode {
  const [showPassed, setShowPassed] = useState(false);
  const { notPassed, passed } = splitFindings(detail.findings);
  const rows = showPassed ? [...notPassed, ...passed] : notPassed;
  const runNo = detail.qa.runNo;
  return (
    <Card testId="package-checks">
      <SectionHeader aside={runNo === null ? undefined : `Run ${runNo}`}>Checks</SectionHeader>
      {detail.content === null ? (
        <NotGenerated />
      ) : detail.findings.length === 0 ? (
        <EmptyState title="The checks have not answered yet" />
      ) : (
        <>
          {overridesOf(detail.findings).map((o) => (
            <p key={`${o.at} ${o.reason}`} className="pb-notice" data-testid="package-override">
              <span>
                {plural(o.checks, 'failed check')} overridden by {o.approver},{' '}
                {formatDateTime(o.at)}. Reason: {o.reason}
              </span>
            </p>
          ))}
          {notPassed.length === 0 ? (
            <p className="pb-meta pb-pkg-note" data-testid="package-checks-passed">
              All {plural(passed.length, 'check')} passed.
            </p>
          ) : null}
          {rows.length === 0 ? null : <ChecksTable rows={rows} names={names} />}
          {passed.length === 0 ? null : (
            <div className="pb-pkg-toggle">
              <Button
                size="small"
                appearance="secondary"
                aria-expanded={showPassed}
                onClick={() => setShowPassed((shown) => !shown)}
              >
                {showPassed
                  ? `Hide the ${passed.length === 1 ? 'check' : 'checks'} that passed`
                  : `Show the ${plural(passed.length, 'check')} that passed`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** A figure of a line, right aligned; the placeholder is muted and says why the figure is missing. */
function FigureTd({ cell }: { cell: FigureCell }): ReactNode {
  if (cell.why === undefined) return <NumCell>{cell.text}</NumCell>;
  return (
    <td className="num is-missing" title={cell.why}>
      {cell.text}
      <span className="pb-visually-hidden"> {cell.why}</span>
    </td>
  );
}

/**
 * The positions of the package for the quarter, as stored (docs/08 section 7). The page adds
 * nothing up: there is no totals row. The figures are the reading of whoever generated the
 * package, so a position behind an information wall that person is not on is not among them,
 * and the card says so instead of calling the package complete.
 */
function PositionsCard({
  detail,
  content,
  names,
}: {
  detail: ReportPackageDetail;
  content: ReportPackageContent | null;
  names: PositionNames;
}): ReactNode {
  return (
    <Card testId="package-positions">
      <SectionHeader
        aside={content === null ? undefined : plural(content.lines.length, 'position')}
      >
        Positions
      </SectionHeader>
      {content === null ? (
        <NotGenerated />
      ) : (
        <>
          <p className="pb-meta pb-pkg-note" data-testid="package-positions-note">
            Built from the positions {generatedBy(detail)} could read when it was generated. A
            position behind an information wall that person is not on is not included.
          </p>
          {content.lines.length === 0 ? (
            <EmptyState title="No positions in this package" />
          ) : (
            <TableWrap label="Positions">
              <table className="pb-table" aria-label="Positions">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th className="num">Begin NAV</th>
                    <th className="num">Contributions</th>
                    <th className="num">Distributions</th>
                    <th className="num">Gain or loss</th>
                    <th className="num">End NAV</th>
                    <th>Mark</th>
                  </tr>
                </thead>
                <tbody>
                  {content.lines.map((line) => {
                    const mark = markCell(line, content.periodEnd);
                    return (
                      <tr key={line.ref}>
                        <PositionTh positionRef={line.ref} names={names} />
                        <FigureTd cell={beginNavCell(line)} />
                        <NumCell>{formatMoneyM(line.contributions)}</NumCell>
                        <NumCell>{formatMoneyM(line.distributions)}</NumCell>
                        <FigureTd cell={gainLossCell(line)} />
                        <FigureTd cell={endNavCell(line)} />
                        {mark.why === undefined ? (
                          <td className="pb-nowrap">{mark.text}</td>
                        ) : (
                          <td className="is-missing" title={mark.why}>
                            {mark.text}
                            <span className="pb-visually-hidden"> {mark.why}</span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      )}
    </Card>
  );
}

function FootnotesCard({
  content,
  names,
}: {
  content: ReportPackageContent | null;
  names: PositionNames;
}): ReactNode {
  return (
    <Card testId="package-footnotes">
      <SectionHeader>Footnotes</SectionHeader>
      {content === null ? (
        <NotGenerated />
      ) : content.footnotes.length === 0 ? (
        <EmptyState title="No footnotes" />
      ) : (
        <TableWrap label="Footnotes">
          <table className="pb-table" aria-label="Footnotes">
            <thead>
              <tr>
                <th>Position</th>
                <th>Footnote</th>
              </tr>
            </thead>
            <tbody>
              {content.footnotes.map((note) => (
                <tr key={`${note.ref} ${note.code}`}>
                  <PositionTh positionRef={note.ref} names={names} />
                  <td>
                    {footnoteWords(
                      note.code,
                      content.lines.find((line) => line.ref === note.ref),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

/**
 * The client's share of each position's end NAV, as stored. A position with no end NAV, or in a
 * vehicle the client's ownership share is not on record for, has no line: the card counts those
 * instead of showing a share of nothing.
 */
function ClientShareCard({
  content,
  names,
}: {
  content: ReportPackageContent | null;
  names: PositionNames;
}): ReactNode {
  const rows = clientShareRows(content?.clientLines ?? []);
  const shared = new Set(rows.map((line) => line.ref));
  const without = content?.lines.filter((line) => !shared.has(line.ref)).length ?? 0;
  return (
    <Card testId="package-client-share">
      <SectionHeader>Client share</SectionHeader>
      {content === null ? (
        <NotGenerated />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No client share to show"
          detail="A line appears for each position with an end NAV, once the client's ownership share of its vehicle is on record."
        />
      ) : (
        <>
          <TableWrap label="Client share">
            <table className="pb-table" aria-label="Client share">
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="num">Ownership</th>
                  <th className="num">Client NAV</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((line, i) => (
                  // Two commitments to one vehicle give a position two lines: the row is its place.
                  <tr key={`${line.ref} ${i}`}>
                    <PositionTh positionRef={line.ref} names={names} />
                    <NumCell>{formatPct(line.ownershipPct)}</NumCell>
                    <NumCell>{formatMoneyM(line.nav)}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {without === 0 ? null : (
            <p className="pb-meta" data-testid="package-client-share-gaps">
              {plural(without, 'position')} of the package {without === 1 ? 'has' : 'have'} no
              client line: no end NAV, or no ownership share on record.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** Why a begin NAV differs from the last released package, position by position; kept for good once recorded. */
function ExplanationsCard({
  detail,
  content,
  names,
}: {
  detail: ReportPackageDetail;
  content: ReportPackageContent | null;
  names: PositionNames;
}): ReactNode {
  const rows = explanationRows(detail.tieOutExplanations);
  return (
    <Card testId="package-explanations">
      <SectionHeader>Tie-out explanations</SectionHeader>
      {content === null ? (
        <NotGenerated />
      ) : (
        <>
          <p className="pb-meta pb-pkg-note">
            {content.priorRelease === null
              ? 'No earlier package was released to this client on this basis, so there is nothing to tie to.'
              : 'Each begin NAV is tied to the end NAV of the last package released to this client on this basis. A difference needs an explanation.'}
          </p>
          {rows.length === 0 ? (
            <EmptyState title="No explanations recorded" />
          ) : (
            <TableWrap label="Tie-out explanations">
              <table className="pb-table" aria-label="Tie-out explanations">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.ref}>
                      <PositionTh positionRef={row.ref} names={names} />
                      <td>{row.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      )}
    </Card>
  );
}

function ChangeLogCard({ detail }: { detail: ReportPackageDetail }): ReactNode {
  const rows = changeLogRows(detail.changeLog);
  return (
    <Card testId="package-change-log">
      <SectionHeader aside={rows.length > 1 ? 'Newest first' : undefined}>Change log</SectionHeader>
      {rows.length === 0 ? (
        <NotGenerated />
      ) : (
        <>
          <p className="pb-meta pb-pkg-note">
            Generation runs. Every other step is in the audit trail.
          </p>
          <TableWrap label="Change log">
            <table className="pb-table" aria-label="Change log">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>When</th>
                  <th>By</th>
                  <th className="num">Positions</th>
                  <th className="num">Checks</th>
                  <th className="num">Failed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.runNo}>
                    <th scope="row">Run {row.runNo}</th>
                    <td className="pb-nowrap">{row.at}</td>
                    <td>{row.by}</td>
                    <NumCell>{String(row.positions)}</NumCell>
                    <NumCell>{String(row.checks)}</NumCell>
                    <NumCell>{String(row.failed)}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </Card>
  );
}

function Body({ detail }: { detail: ReportPackageDetail }): ReactNode {
  const log = useActionLog();
  // The reader's own positions list gives each number its company; a position the reader cannot
  // list, or a list that did not load, leaves the number alone.
  const positions = useQuery(investmentsQuery({ limit: LIST_LIMIT }));
  const names = useMemo(() => positionNames(positions.data?.items ?? []), [positions.data]);
  const { content } = detail;
  return (
    <div data-testid="package-detail">
      <BackLink />
      <PageHeader
        testId="package-banner"
        title={`${detail.client.name}: ${formatQuarter(detail.periodEnd)}`}
        meta={
          <span className="pb-meta-list">
            <span>{BASIS_WORDS[detail.basis]}</span>
            <span>{LABEL_WORDS[detail.label]}</span>
            <span>Version {detail.version}</span>
            <span>As of {formatDate(detail.asOf)}</span>
          </span>
        }
        actions={<PackageStateBadge state={detail.state} />}
      />
      {detail.basis === 'net' ? (
        <p className="pb-notice pb-pkg-standing" data-testid="package-net-notice">
          {NET_NOTICE}
        </p>
      ) : null}
      <ActionStatus latest={log.latest} testId="package-action-status" />
      <ReleaseGateCard detail={detail} />
      <ChecksCard detail={detail} names={names} />
      <PositionsCard detail={detail} content={content} names={names} />
      <div className="pb-two-col">
        <FootnotesCard content={content} names={names} />
        <ClientShareCard content={content} names={names} />
      </div>
      <ExplanationsCard detail={detail} content={content} names={names} />
      <ChangeLogCard detail={detail} />
      <ActionLogCard entries={log.entries} />
    </div>
  );
}

/**
 * One reporting package (docs/04 M14): its header, its release gate, the checks of its latest
 * run with what each expected and found, its positions, footnotes and client share as stored,
 * the tie-out explanations and the generation runs. A package of a client the reader does not
 * read answers 404 and reads as not found, so nothing says it exists.
 */
export function PackageDetailPage(): ReactNode {
  const { id } = useParams({ from: '/app/reporting/packages/$id' });
  const q = useQuery(reportPackageQuery(id));
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <>
        <BackLink />
        {missing ? (
          <ErrorState
            title="Package not found"
            detail="There is no package at this address among the clients you read."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This package"
            forbidden={{
              title: 'This package: not visible to your role',
              detail: WHO_READS_PACKAGES,
            }}
            errorTitle="Package unavailable"
            testId="package-unavailable"
          />
        )}
      </>
    );
  }
  return <Body detail={q.data} />;
}
