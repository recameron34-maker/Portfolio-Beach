import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { DealStage, OpportunityDetail } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Breadcrumbs,
  Card,
  EmptyState,
  ErrorState,
  KeyValueTable,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  SimulatedBadge,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import { StepStrip } from '../../components/StepStrip.js';
import { ActionLogCard, ActionStatus } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  labelOf,
  MISSING,
  plural,
} from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { useActionLog } from '../../lib/workflow.js';
import { AllocationsEditor } from './AllocationsEditor.js';
import { opportunityQuery } from './api.js';
import { DealFitCard } from './DealFit.js';
import { DiligenceTasksCard } from './DiligenceTasks.js';
import { IcDecisionsCard } from './IcDecisions.js';
import {
  agingHint,
  allocationsLock,
  gateLines,
  isAging,
  personName,
  stageSteps,
  tieOutLabel,
} from './pipeline.js';
import { StageActions } from './StageActions.js';
import { closingTone } from '../../lib/states.js';
import './pipeline.css';

const TRAIL = [{ label: 'Pipeline', to: '/pipeline' }];

/** The live stages of docs/18 section 4 as an ordered strip; the current one is marked. */
function StageStrip({ stage }: { stage: DealStage }): ReactNode {
  return (
    <StepStrip
      label="Deal stages"
      steps={stageSteps(stage).map((step) => ({
        key: step.stage,
        label: humanizeState(step.stage),
        status: step.status,
      }))}
    />
  );
}

/**
 * The stage as a word with its days in it, a neutral dot unless the deal sits past the stage's
 * guide (watch). A settled deal (Closed, Passed) shows its stage alone.
 */
export function StageWord({
  stage,
  daysInStage,
}: {
  stage: DealStage;
  daysInStage: number;
}): ReactNode {
  const settled = stage === 'Closed' || stage === 'Passed';
  const word = settled
    ? humanizeState(stage)
    : `${humanizeState(stage)}, ${plural(daysInStage, 'day')}`;
  const hint = agingHint(stage, daysInStage);
  return (
    <span className="pb-pipe-stage" title={hint ?? undefined}>
      <Badge tone={isAging(stage, daysInStage) ? 'watch' : 'neutral'}>{word}</Badge>
    </span>
  );
}

/**
 * The gates the stage commands check (docs/18 sections 4 and 12), each a dot and a sentence, and
 * where the deal went once it settled: the pass with its reason, or the position it became.
 */
function GatesCard({ detail }: { detail: OpportunityDetail }): ReactNode {
  return (
    <Card testId="opportunity-gates">
      <SectionHeader>Gates</SectionHeader>
      {detail.stage === 'Passed' ? (
        <KeyValueTable
          label="Pass"
          columns={1}
          rows={[
            { label: 'Reason', value: labelOf(detail.passReasonCode) },
            { label: 'Note', value: detail.passNote ?? MISSING },
          ]}
        />
      ) : null}
      {detail.stage === 'Closed' && detail.investmentId !== null ? (
        <p className="pb-pipe-outcome">
          Converted into a position:{' '}
          <Link to="/portfolio/$id" params={{ id: detail.investmentId }}>
            open the deal workspace
          </Link>
          .
        </p>
      ) : null}
      <ul className="pb-pipe-gates">
        {gateLines(detail.gates, detail.closing !== null).map((g) => (
          <li key={g.key}>
            <Badge tone={g.ok ? 'good' : 'watch'}>{g.ok ? 'Clear' : 'Waiting'}</Badge>
            <span>{g.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HistoryCard({ detail }: { detail: OpportunityDetail }): ReactNode {
  const rows = [...detail.stageHistory].sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  return (
    <Card testId="opportunity-history">
      <SectionHeader aside={rows.length === 0 ? undefined : 'Newest first'}>
        Stage history
      </SectionHeader>
      {rows.length === 0 ? (
        <p className="pb-meta">No stage changes recorded.</p>
      ) : (
        <TableWrap label="Stage history">
          <table className="pb-table" aria-label="Stage history">
            <thead>
              <tr>
                <th className="pb-col-fit">When</th>
                <th className="pb-col-fit">From</th>
                <th className="pb-col-fit">To</th>
                <th className="pb-col-fit">Command</th>
                <th className="pb-col-fit">By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={`${h.changedAt}-${i}`}>
                  <td className="pb-col-fit">{formatDateTime(h.changedAt)}</td>
                  <td className="pb-col-fit">
                    {h.fromStage === null ? MISSING : humanizeState(h.fromStage)}
                  </td>
                  <td className="pb-col-fit">{humanizeState(h.toStage)}</td>
                  <td className="pb-col-fit">{humanizeState(h.command)}</td>
                  <td className="pb-col-fit">{h.changedBy.name}</td>
                  <td className="pb-col-text">{h.reason ?? MISSING}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function ClosingSummaryCard({ detail }: { detail: OpportunityDetail }): ReactNode {
  const c = detail.closing;
  return (
    <Card testId="opportunity-closing">
      <SectionHeader>Closing</SectionHeader>
      {c === null ? (
        <EmptyState
          title="No closing record yet"
          detail="The closing opens when the deal advances from Approved with a close date and a commitment."
          testId="opportunity-closing-empty"
        />
      ) : (
        <>
          <KeyValueTable
            label="Closing summary"
            rows={[
              { label: 'Close date', value: formatDate(c.closeDate) },
              { label: 'Commitment', value: formatMoneyM(c.commitmentAmount) },
              {
                label: 'State',
                value: <Badge tone={closingTone(c.state)}>{humanizeState(c.state)}</Badge>,
              },
              { label: 'Confirmed by', value: personName(c.opsConfirmedBy) },
              {
                label: 'Items open',
                value: `${c.itemsOpen} (${c.itemsRequiredOpen} required)`,
              },
              { label: 'Allocation tie-out', value: tieOutLabel(c.allocationTieOut) },
            ]}
          />
          <p className="pb-note">
            <Link to="/pipeline/$id/closing" params={{ id: detail.id }}>
              Open the closing page
            </Link>{' '}
            for the checklist, the confirmation and the legal terms.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The record facts after who and when: where the deal came from, its sector, geography and
 * currency. A fact the record lacks keeps its name and shows the missing placeholder (docs/06).
 */
function contextItems(detail: OpportunityDetail): string[] {
  return [
    detail.sponsorFund === null
      ? detail.sponsor.name
      : `${detail.sponsor.name}, ${detail.sponsorFund.name}`,
    labelOf(detail.dealType),
    `Received ${formatDate(detail.receivedDate)}`,
    `Deal lead ${personName(detail.owner)}`,
    `Source: ${detail.source ?? MISSING}`,
    detail.sector === null ? `Sector: ${MISSING}` : labelOf(detail.sector),
    detail.geography === null ? `Geography: ${MISSING}` : labelOf(detail.geography),
    detail.currency,
  ];
}

function Body({
  detail,
  roles,
}: {
  detail: OpportunityDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  const requiredOpen = detail.gates.diligence.requiredOpen;
  const agingNote = agingHint(detail.stage, detail.daysInStage);
  return (
    <div data-testid="opportunity-detail">
      <PageHeader
        testId="opportunity-banner"
        crumbs={TRAIL}
        title={`${detail.name}: ${detail.companyName}`}
        meta={
          <span className="pb-meta-list">
            {contextItems(detail).map((item, i) => (
              <span key={i}>{item}</span>
            ))}
          </span>
        }
        actions={
          <span className="pb-pipe-head-actions">
            <StageWord stage={detail.stage} daysInStage={detail.daysInStage} />
            <StageActions detail={detail} roles={roles} log={log} />
            <SimulatedBadge />
          </span>
        }
      />
      <ActionStatus latest={log.latest} testId="opportunity-action-status" />
      <StageStrip stage={detail.stage} />
      <div ref={balanceTiles} className="pb-tiles" data-testid="opportunity-tiles">
        <StatTile
          label="Target commitment"
          value={formatMoneyM(detail.targetCommitment)}
          hint={detail.currency}
        />
        <StatTile
          label="Days in stage"
          value={String(detail.daysInStage)}
          hint={agingNote ?? undefined}
          tone={agingNote === null ? undefined : 'watch'}
        />
        <StatTile
          label="Required tasks open"
          value={String(requiredOpen)}
          hint="Diligence tasks required for IC"
          tone={requiredOpen > 0 ? 'watch' : undefined}
        />
        <StatTile
          label="Allocation tie-out"
          value={detail.closing === null ? MISSING : tieOutLabel(detail.closing.allocationTieOut)}
          hint={
            detail.closing === null
              ? 'No closing record yet'
              : 'Received amounts against the closing commitment'
          }
          tone={
            detail.closing === null
              ? undefined
              : detail.closing.allocationTieOut.tiedOut
                ? 'good'
                : 'bad'
          }
        />
      </div>
      <GatesCard detail={detail} />
      <DiligenceTasksCard
        opportunityId={detail.id}
        tasks={detail.diligenceTasks}
        carriedOver={detail.gates.diligence.carriedOver}
        roles={roles}
        log={log}
      />
      <div className="pb-two-col">
        <IcDecisionsCard
          opportunityId={detail.id}
          stage={detail.stage}
          decisions={detail.icDecisions}
          roles={roles}
          log={log}
        />
        <AllocationsEditor
          opportunityId={detail.id}
          name={detail.name}
          rows={detail.allocations}
          totals={detail.allocationTotals}
          targetCommitment={detail.targetCommitment}
          closing={detail.closing}
          rowVersion={detail.rowVersion}
          roles={roles}
          log={log}
          lock={allocationsLock(detail.stage, detail.closing)}
        />
      </div>
      <DealFitCard detail={detail} />
      <HistoryCard detail={detail} />
      <ClosingSummaryCard detail={detail} />
      <ActionLogCard entries={log.entries} />
    </div>
  );
}

/**
 * One opportunity (docs/04 M5): the stage and its commands of docs/18 section 4 in the header, the
 * stage strip and figures, the gates the commands check (the operations confirmation of the
 * closing among them), the diligence tasks, IC decisions beside the allocations (read only while
 * the closing is confirmed), the portfolio fit, stage history and the closing summary with the
 * way to the closing page.
 */
export function OpportunityPage(): ReactNode {
  const { id } = useParams({ from: '/app/pipeline/$id' });
  const me = useQuery(meQuery);
  const q = useQuery(opportunityQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (q.isError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <>
        <Breadcrumbs items={TRAIL} />
        {hidden ? (
          <ErrorState
            title="Opportunity not found or not visible to you"
            detail="There is no opportunity with this id in your view of the pipeline. It may sit behind an information wall you are not on."
          />
        ) : (
          <UnavailableState
            card
            error={q.error}
            subject="This opportunity"
            errorTitle="Opportunity unavailable"
            testId="opportunity-unavailable"
          />
        )}
      </>
    );
  }
  return <Body detail={q.data} roles={me.data?.roles ?? []} />;
}
