import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { DealStage, OpportunityDetail } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
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
import { ActionLogCard, ActionStatus } from '../../components/WorkflowActions.js';
import { formatDate, formatDateTime, formatMoneyM, labelOf, MISSING } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { balanceTiles } from '../../lib/tiles.js';
import { useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { AllocationsEditor } from './AllocationsEditor.js';
import { opportunityQuery } from './api.js';
import { DiligenceTasksCard } from './DiligenceTasks.js';
import { IcDecisionsCard } from './IcDecisions.js';
import {
  agingHint,
  daysInStageLabel,
  gateLines,
  isAging,
  personName,
  stageSteps,
  tieOutLabel,
} from './pipeline.js';
import { StageActions } from './StageActions.js';
import { closingTone, stageTone } from '../../lib/states.js';
import './pipeline.css';

function BackLink(): ReactNode {
  return (
    <p className="pb-meta pb-pipe-back">
      <Link to="/pipeline">Pipeline board</Link>
    </p>
  );
}

/** The live stages of docs/18 section 4 as an ordered strip; the current one is marked. */
function StageStrip({ stage }: { stage: DealStage }): ReactNode {
  return (
    <ol className="pb-pipe-stages" aria-label="Deal stages">
      {stageSteps(stage).map((step) => (
        <li
          key={step.stage}
          data-status={step.status}
          {...(step.status === 'current' ? { 'aria-current': 'step' as const } : {})}
        >
          <span>{humanizeState(step.stage)}</span>
          {step.status === 'done' ? (
            <Badge tone="good">Done</Badge>
          ) : step.status === 'current' ? (
            <Badge tone="brand">Current</Badge>
          ) : (
            <Badge plain>Upcoming</Badge>
          )}
        </li>
      ))}
    </ol>
  );
}

function GatesCard({ detail }: { detail: OpportunityDetail }): ReactNode {
  return (
    <Card testId="opportunity-gates">
      <SectionHeader>Gates</SectionHeader>
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

function WorkflowCard({
  detail,
  roles,
  log,
}: {
  detail: OpportunityDetail;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  return (
    <Card testId="opportunity-workflow">
      <SectionHeader aside={<SimulatedBadge />}>Stage</SectionHeader>
      <ActionStatus latest={log.latest} testId="opportunity-action-status" />
      <StageActions detail={detail} roles={roles} log={log} />
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
        <p className="pb-meta">
          Converted into a position:{' '}
          <Link to="/portfolio/$id" params={{ id: detail.investmentId }}>
            open the deal workspace
          </Link>
          .
        </p>
      ) : null}
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
        <EmptyState title="No stage changes recorded" />
      ) : (
        <TableWrap label="Stage history">
          <table className="pb-table" aria-label="Stage history">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th>Command</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={`${h.changedAt}-${i}`}>
                  <td className="pb-nowrap">{formatDateTime(h.changedAt)}</td>
                  <td>{h.fromStage === null ? MISSING : humanizeState(h.fromStage)}</td>
                  <td>
                    <Badge tone={stageTone(h.toStage)}>{humanizeState(h.toStage)}</Badge>
                  </td>
                  <td>{humanizeState(h.command)}</td>
                  <td>{h.changedBy.name}</td>
                  <td>{h.reason ?? MISSING}</td>
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
          detail="The closing opens when the deal advances from Approved with a close date and a commitment (docs/04 M8)."
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
          <p className="pb-meta pb-deal-note">
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

function Body({
  detail,
  roles,
}: {
  detail: OpportunityDetail;
  roles: readonly string[];
}): ReactNode {
  const log = useActionLog();
  const aging = isAging(detail.stage, detail.daysInStage);
  const requiredOpen = detail.gates.diligence.requiredOpen;
  return (
    <div data-testid="opportunity-detail">
      <BackLink />
      <PageHeader
        testId="opportunity-banner"
        title={`${detail.name}: ${detail.companyName}`}
        meta={
          <span className="pb-meta-list">
            <span>
              {detail.sponsor.name}
              {detail.sponsorFund === null ? '' : `, ${detail.sponsorFund.name}`}
            </span>
            <span>{labelOf(detail.dealType)}</span>
            <span>Received {formatDate(detail.receivedDate)}</span>
            <span>Deal lead {personName(detail.owner)}</span>
          </span>
        }
        actions={<Badge tone={stageTone(detail.stage)}>{humanizeState(detail.stage)}</Badge>}
      />
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
          hint={agingHint(detail.stage, detail.daysInStage) ?? daysInStageLabel(detail.daysInStage)}
          tone={aging ? 'watch' : undefined}
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
            detail.closing === null ? 'No closing record yet' : 'Against the closing commitment'
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
      <div className="pb-two-col">
        <WorkflowCard detail={detail} roles={roles} log={log} />
        <GatesCard detail={detail} />
      </div>
      <DiligenceTasksCard
        opportunityId={detail.id}
        tasks={detail.diligenceTasks}
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
          closing={detail.closing}
          rowVersion={detail.rowVersion}
          roles={roles}
          log={log}
        />
      </div>
      <div className="pb-two-col">
        <HistoryCard detail={detail} />
        <ClosingSummaryCard detail={detail} />
      </div>
      <KeyValueTable
        label="Record"
        rows={[
          { label: 'Source', value: detail.source ?? MISSING },
          { label: 'Sector', value: detail.sector === null ? MISSING : labelOf(detail.sector) },
          {
            label: 'Geography',
            value: detail.geography === null ? MISSING : labelOf(detail.geography),
          },
          { label: 'Currency', value: detail.currency },
        ]}
      />
      <ActionLogCard entries={log.entries} />
    </div>
  );
}

/**
 * One opportunity (docs/04 M5): the stage strip and commands of docs/18 section 4, the gates the
 * commands check, the diligence tasks, IC decisions, allocations, stage history and the closing
 * summary with the way to the closing page.
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
        <BackLink />
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
