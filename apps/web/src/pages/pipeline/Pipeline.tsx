import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Label, Option } from '@fluentui/react-components';
import { Add16Regular } from '@fluentui/react-icons';
import type { DealStage, OpportunityPage, OpportunityRow } from '@pb/contracts';
import { dealStageMachine } from '@pb/workflows';
import { meQuery } from '../../app/queries.js';
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
  Toolbar,
} from '../../components/ui.js';
import { WorkflowSpec } from '../../components/WorkflowSpec.js';
import { formatMoneyM, labelOf, MISSING, plural } from '../../lib/format.js';
import { humanizeState } from '../../lib/states.js';
import { blockedTitle } from '../../lib/workflow.js';
import { balanceTiles } from '../../lib/tiles.js';
import { opportunitiesQuery } from './api.js';
import {
  agingHint,
  agingTone,
  daysInStageLabel,
  dealTypeOptions,
  filterOpportunities,
  groupByStage,
  isAging,
  mayUse,
  ownerOptions,
  PIPELINE_ROLES,
  STAGES,
} from './pipeline.js';
import type { PipelineFilters } from './pipeline.js';
import './pipeline.css';

const META =
  'Every deal from first look to close, one column per stage (docs/18 section 4). Passed deals keep their reason code.';

/** How many days a card has sat in its stage; aging reads as a watch badge with the guide in its title. */
function DaysInStage({ row }: { row: OpportunityRow }): ReactNode {
  const label = daysInStageLabel(row.daysInStage);
  if (!isAging(row.stage, row.daysInStage)) return <span>{label}</span>;
  return (
    <span title={agingHint(row.stage, row.daysInStage) ?? undefined}>
      <Badge tone="watch">{label}</Badge>
    </span>
  );
}

function OpportunityCard({ row }: { row: OpportunityRow }): ReactNode {
  return (
    <li
      className="pb-pipe-card"
      data-testid={`opportunity-card-${row.id}`}
      data-tone={agingTone(row.stage, row.daysInStage)}
    >
      <Link to="/pipeline/$id" params={{ id: row.id }}>
        {row.name}
      </Link>
      <span className="pb-meta">{row.companyName}</span>
      <span className="pb-meta">
        {row.sponsor.name}
        {row.sponsorFund === null ? '' : `, ${row.sponsorFund.name}`}
      </span>
      <span className="pb-pipe-card-foot">
        <Badge plain>{labelOf(row.dealType)}</Badge>
        <span>{formatMoneyM(row.targetCommitment)}</span>
      </span>
      <span className="pb-pipe-card-foot">
        <span>{row.owner === null ? 'No deal lead' : row.owner.name}</span>
        <DaysInStage row={row} />
      </span>
    </li>
  );
}

function Column({ stage, rows }: { stage: DealStage; rows: readonly OpportunityRow[] }): ReactNode {
  return (
    <li className="pb-pipe-column" data-testid={`pipeline-column-${stage}`}>
      <h3>
        <span>{humanizeState(stage)}</span>
        <Badge plain>{rows.length}</Badge>
      </h3>
      {rows.length === 0 ? (
        <p className="pb-pipe-empty">No deals at {humanizeState(stage)}</p>
      ) : (
        <ul className="pb-pipe-cards" aria-label={`${humanizeState(stage)} deals`}>
          {rows.map((r) => (
            <OpportunityCard key={r.id} row={r} />
          ))}
        </ul>
      )}
    </li>
  );
}

interface Counts {
  live: number;
  aging: number;
  closing: number;
  passed: number;
}

/** Counts of deals (never money): in flight, aging past the guide, at Closing, and Passed. */
function counts(rows: readonly OpportunityRow[]): Counts {
  const c: Counts = { live: 0, aging: 0, closing: 0, passed: 0 };
  for (const r of rows) {
    if (r.stage === 'Passed') c.passed += 1;
    else if (r.stage !== 'Closed') c.live += 1;
    if (r.stage === 'Closing') c.closing += 1;
    if (isAging(r.stage, r.daysInStage)) c.aging += 1;
  }
  return c;
}

function Board({ page, roles }: { page: OpportunityPage; roles: readonly string[] }): ReactNode {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PipelineFilters>({ ownerId: '', dealType: '' });
  const canCreate = mayUse(roles, PIPELINE_ROLES.createOpportunity);
  const newBlocked = blockedTitle({ allowed: canCreate, roles: PIPELINE_ROLES.createOpportunity });
  const rows = filterOpportunities(page.items, filters);
  const columns = groupByStage(rows);
  const owners = ownerOptions(page.items);
  const dealTypes = dealTypeOptions(page.items);
  const owner = owners.find((o) => o.id === filters.ownerId);
  const c = counts(page.items);
  const partial = page.nextCursor !== null;
  return (
    <>
      <PageHeader
        title="Pipeline"
        meta={META}
        actions={
          <Button
            size="small"
            appearance="primary"
            icon={<Add16Regular />}
            disabled={newBlocked !== null}
            {...(newBlocked === null ? {} : { title: newBlocked })}
            onClick={() => void navigate({ to: '/pipeline/new' })}
          >
            New opportunity
          </Button>
        }
      />
      <div ref={balanceTiles} className="pb-tiles" data-testid="pipeline-tiles">
        <CountTile
          label="In pipeline"
          count={c.live}
          hint="Sourced through Closing"
          partial={partial}
        />
        <CountTile
          label="Aging"
          count={c.aging}
          hint="Past the stage guide (config pipeline.stageAgingDays)"
          tone={c.aging > 0 ? 'watch' : undefined}
          partial={partial}
        />
        <CountTile
          label="At closing"
          count={c.closing}
          hint="Checklist and tie-out in progress"
          partial={partial}
        />
        <CountTile label="Passed" count={c.passed} hint="With a reason code" partial={partial} />
      </div>
      <Card testId="pipeline-card">
        <SectionHeader aside={`${rows.length} of ${plural(page.items.length, 'deal')}`}>
          Board
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="pipeline-owner">Deal lead</Label>
            <Dropdown
              id="pipeline-owner"
              className="pb-pipe-filter"
              value={owner === undefined ? 'All deal leads' : owner.name}
              selectedOptions={[filters.ownerId]}
              onOptionSelect={(_e, d) =>
                setFilters((f) => ({ ...f, ownerId: d.optionValue ?? '' }))
              }
            >
              <Option value="">All deal leads</Option>
              {owners.map((o) => (
                <Option key={o.id} value={o.id} text={o.name}>
                  {o.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="pipeline-deal-type">Deal type</Label>
            <Dropdown
              id="pipeline-deal-type"
              className="pb-pipe-filter"
              value={filters.dealType === '' ? 'All deal types' : labelOf(filters.dealType)}
              selectedOptions={[filters.dealType]}
              onOptionSelect={(_e, d) =>
                setFilters((f) => ({ ...f, dealType: d.optionValue ?? '' }))
              }
            >
              <Option value="">All deal types</Option>
              {dealTypes.map((code) => (
                <Option key={code} value={code} text={labelOf(code)}>
                  {labelOf(code)}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>
        {page.items.length === 0 ? (
          <EmptyState
            title="No opportunities yet"
            detail="Deals appear here once the deal team logs a new opportunity."
            testId="pipeline-empty"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No deals match these filters"
            detail="Pick another deal lead or deal type."
            testId="pipeline-empty"
          />
        ) : null}
        {page.items.length === 0 ? null : (
          <ol className="pb-pipe-board" data-testid="pipeline-board" aria-label="Pipeline board">
            {STAGES.map((stage) => (
              <Column key={stage} stage={stage} rows={columns.get(stage) ?? []} />
            ))}
          </ol>
        )}
        {partial ? (
          <p className="pb-meta" data-testid="pipeline-truncated">
            Showing the first {page.items.length} deals; more exist, so the counts above read{' '}
            {MISSING}.
          </p>
        ) : null}
      </Card>
      <WorkflowSpec
        machine={dealStageMachine}
        title="Deal stages"
        detail="Every deal moves from sourcing to close through these stages, with the IC gate and the closing checks in the table."
      />
    </>
  );
}

/**
 * The pipeline board (docs/04 M5): one column per stage in the order of docs/18 section 4 with
 * Passed last, a card per deal with its days in stage against the aging guide, filters by deal
 * lead and deal type, and the way in to a new opportunity for the deal team.
 */
export function PipelinePage(): ReactNode {
  const me = useQuery(meQuery);
  const board = useQuery({ ...opportunitiesQuery({}), placeholderData: keepPreviousData });
  if (board.isPending) return <PageSkeleton tiles={4} rows={8} />;
  if (board.isError) {
    return (
      <>
        <PageHeader title="Pipeline" meta={META} />
        <UnavailableState
          card
          error={board.error}
          subject="The pipeline board"
          errorTitle="Pipeline board unavailable"
          testId="pipeline-unavailable"
        />
      </>
    );
  }
  return <Board page={board.data} roles={me.data?.roles ?? []} />;
}
