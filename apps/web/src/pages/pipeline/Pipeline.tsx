import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  Subhead,
  TableWrap,
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
  'Every deal from first look to close: one column a stage in flight, then the closed and passed deals. Passed deals keep their reason code.';

/** The stages drawn as columns, Sourced through Closing; Closed and Passed follow the board as a table. */
const BOARD_STAGES: readonly DealStage[] = STAGES.filter((s) => s !== 'Closed' && s !== 'Passed');

function isSettled(stage: DealStage): boolean {
  return stage === 'Closed' || stage === 'Passed';
}

function sponsorText(row: OpportunityRow): string {
  return row.sponsorFund === null
    ? row.sponsor.name
    : `${row.sponsor.name}, ${row.sponsorFund.name}`;
}

/** The target commitment; a deal with none says so to a screen reader and shows the placeholder. */
function Target({ value }: { value: string | null }): ReactNode {
  return value === null ? (
    <span className="pb-pipe-target is-missing">
      <span aria-hidden="true">{MISSING}</span>
      <span className="pb-visually-hidden">Target not recorded</span>
    </span>
  ) : (
    <span className="pb-pipe-target">
      <span className="pb-visually-hidden">Target </span>
      {formatMoneyM(value)}
    </span>
  );
}

/**
 * How many days a deal has sat in its stage. Past the stage's guide it reads as a watch dot and the
 * days in the watch ink, with the guide in its title; within the guide it is plain text.
 */
function DaysInStage({ row }: { row: OpportunityRow }): ReactNode {
  const words = (
    <>
      {plural(row.daysInStage, 'day')}
      <span className="pb-visually-hidden"> in stage</span>
    </>
  );
  const hint = agingHint(row.stage, row.daysInStage);
  if (hint === null) return <span className="pb-pipe-days">{words}</span>;
  return (
    <span className="pb-pipe-days" title={hint}>
      <Badge tone="watch">{words}</Badge>
    </span>
  );
}

/**
 * A deal on the board: the same rows on every card, in the same order, so cards compare down a
 * column: the deal, the company, the sponsor and fund, the deal type, the deal lead, then the
 * figures (the target on the left, the days in stage on the right). Each line wraps rather than
 * being cut short, so nothing on a card is lost at any width. The whole card opens the deal.
 */
function OpportunityCard({ row }: { row: OpportunityRow }): ReactNode {
  return (
    <li
      className="pb-pipe-card"
      data-testid={`opportunity-card-${row.id}`}
      data-tone={agingTone(row.stage, row.daysInStage)}
    >
      <Link className="pb-pipe-card-name" to="/pipeline/$id" params={{ id: row.id }}>
        {row.name}
      </Link>
      <span className="pb-pipe-card-line">{row.companyName}</span>
      <span className="pb-pipe-card-line">{sponsorText(row)}</span>
      <span className="pb-pipe-card-line">{labelOf(row.dealType)}</span>
      <span className="pb-pipe-card-line">
        {row.owner === null ? 'No deal lead' : row.owner.name}
      </span>
      <span className="pb-pipe-card-row">
        <Target value={row.targetCommitment} />
        <DaysInStage row={row} />
      </span>
    </li>
  );
}

function Column({
  stage,
  rows,
  index,
}: {
  stage: DealStage;
  rows: readonly OpportunityRow[];
  index: number;
}): ReactNode {
  const name = humanizeState(stage);
  return (
    <li
      className="pb-pipe-column"
      data-testid={`pipeline-column-${stage}`}
      style={{ '--i': index } as CSSProperties}
    >
      <h3>
        <span>{name}</span>
        <span className="pb-pipe-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="pb-pipe-empty">None</p>
      ) : (
        <ul className="pb-pipe-cards" aria-label={`${name} deals`}>
          {rows.map((r) => (
            <OpportunityCard key={r.id} row={r} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Closed and Passed deals, with the fields of a card, as one open table after the board. */
function SettledTable({ rows }: { rows: readonly OpportunityRow[] }): ReactNode {
  return (
    <>
      <Subhead>Closed and passed</Subhead>
      <TableWrap label="Closed and passed">
        <table className="pb-table" aria-label="Closed and passed">
          <thead>
            <tr>
              <th>Deal</th>
              <th>Company</th>
              <th>Sponsor and fund</th>
              <th>Deal type</th>
              <th className="num">Target</th>
              <th>Deal lead</th>
              <th className="num">Days in stage</th>
              <th>Stage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`opportunity-row-${r.id}`}>
                <td className="pb-nowrap">
                  <Link to="/pipeline/$id" params={{ id: r.id }}>
                    {r.name}
                  </Link>
                </td>
                <td className="pb-col-text">{r.companyName}</td>
                <td className="pb-col-text">{sponsorText(r)}</td>
                <td>{labelOf(r.dealType)}</td>
                <NumCell>{formatMoneyM(r.targetCommitment)}</NumCell>
                <td className="pb-nowrap">{r.owner === null ? 'No deal lead' : r.owner.name}</td>
                <NumCell>{String(r.daysInStage)}</NumCell>
                <td>{humanizeState(r.stage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
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
  const settled = rows.filter((r) => isSettled(r.stage));
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
          hint="Longer in a stage than its guide"
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
        ) : (
          <>
            <ol className="pb-pipe-board" data-testid="pipeline-board" aria-label="Pipeline board">
              {BOARD_STAGES.map((stage, i) => (
                <Column key={stage} stage={stage} rows={columns.get(stage) ?? []} index={i} />
              ))}
            </ol>
            {settled.length === 0 ? null : <SettledTable rows={settled} />}
          </>
        )}
        {partial ? (
          <p className="pb-meta pb-pipe-note" data-testid="pipeline-truncated">
            Showing the first {page.items.length} deals; more exist, so the counts above read{' '}
            {MISSING}.
          </p>
        ) : null}
      </Card>
      <WorkflowSpec
        machine={dealStageMachine}
        title="Deal stages"
        summary="How a deal moves between stages"
        detail="Every deal moves from sourcing to close through these stages, with the IC gate and the closing checks in the table."
      />
    </>
  );
}

/**
 * The pipeline board (docs/04 M5): one column per live stage in the order of docs/18 section 4, a
 * card per deal with its days in stage against the aging guide, then the Closed and Passed deals
 * as a table with the same fields; filters by deal lead and deal type over both, the way in to a
 * new opportunity for the deal team, and how a deal moves between stages, folded.
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
