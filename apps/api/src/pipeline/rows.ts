import { asc, desc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { D, daysBetween } from '@pb/calc';
import { dealStage, diligenceTaskStatus, icDecisionOutcome } from '@pb/contracts';
import type {
  DealStage,
  DiligenceTask,
  IcDecision,
  OpportunityRow,
  Person,
  StageHistoryEntry,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';

/*
 * The opportunity as the pipeline reads it (docs/04 M5 skeleton, docs/18 section 4, migration
 * 0013): the record with its sponsor, fund and deal lead named, the day its stage was entered (the
 * latest stage history row) and the child rows the detail shows. Every read runs under the
 * caller's row-level security: a walled opportunity is absent for a non-member (SEC-5.3), and a
 * name the caller may not read (a walled sponsor, a client outside their entitlement) shows as
 * NOT_VISIBLE while the id still travels, so the row is never dropped for a name.
 */

export const NOT_FOUND = 'Opportunity not found';
export const ENTITY = 'deal.opportunity';
/** The name shown for a record the caller may not read; the id still travels. */
export const NOT_VISIBLE = 'Not visible';

const opp = schema.opportunity;
const owner = alias(schema.appUser, 'owner');
const changer = alias(schema.appUser, 'changer');
const recorder = alias(schema.appUser, 'recorder');

/** The outer opportunity id for a correlated subquery (Drizzle qualifies joined selects; this stays exact). */
const OUTER_OPPORTUNITY_ID = sql.raw('"deal"."opportunity"."id"');
/** The day the current stage was entered: the latest stage history row as a UTC date, null without history. */
const stageEnteredOn = sql<
  string | null
>`(select to_char(max(h.changed_at) at time zone 'UTC', 'YYYY-MM-DD') from deal.opportunity_stage_history h where h.opportunity_id = ${OUTER_OPPORTUNITY_ID})`;

/** An opportunity row with its names joined and the day its stage was entered. */
export interface LoadedOpportunity {
  id: string;
  name: string;
  companyName: string;
  portfolioCompanyId: string | null;
  sponsorId: string;
  sponsorName: string | null;
  sponsorFundId: string | null;
  sponsorFundName: string | null;
  dealType: string;
  sector: string | null;
  geography: string | null;
  stage: string;
  ownerId: string | null;
  ownerName: string | null;
  receivedDate: string;
  targetCommitment: string | null;
  currency: string;
  source: string | null;
  passReasonCode: string | null;
  passNote: string | null;
  investmentId: string | null;
  rowVersion: number;
  stageEnteredOn: string | null;
}

/** The opportunity as a command locks it: the columns the command reads, guards on and copies. */
export interface LockedOpportunity {
  id: string;
  name: string;
  companyName: string;
  portfolioCompanyId: string | null;
  sponsorId: string;
  sponsorFundId: string | null;
  dealType: string;
  sector: string | null;
  geography: string | null;
  stage: string;
  ownerId: string | null;
  currency: string;
  passReasonCode: string | null;
  passNote: string | null;
  investmentId: string | null;
  rowVersion: number;
}

/** A person reference from an id and the display name the join found (null when the caller may not read it). */
export const person = (id: string | null, name: string | null): Person | null =>
  id === null ? null : { id, name: name ?? NOT_VISIBLE };

/** The stored stage as the machine knows it; anything else is a record the pipeline cannot work. */
export function stageOf(value: string): DealStage {
  const parsed = dealStage.safeParse(value);
  if (!parsed.success)
    throw new ProblemError(
      500,
      'internal',
      'opportunity: the stored stage is not one the pipeline knows',
    );
  return parsed.data;
}

/** A money value from a body must fit the record's two decimals; more is a validation problem, never a silent rounding. */
export function requireMoney(value: string | undefined, path: string): void {
  if (value !== undefined && D(value).decimalPlaces() > 2)
    throw new ProblemError(400, 'validation', 'Invalid body', [
      { path, message: 'At most two decimal places' },
    ]);
}

/** The problem when a command finds the record already changed by another command. */
export const conflict = (what: string): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    `${what}: another command changed the record first; open it again`,
  );

export async function loadOpportunities(
  tx: Tx,
  opts: { where?: SQL | undefined; orderBy?: SQL[]; limit?: number },
): Promise<LoadedOpportunity[]> {
  let query = tx
    .select({
      id: opp.id,
      name: opp.name,
      companyName: opp.companyName,
      portfolioCompanyId: opp.portfolioCompanyId,
      sponsorId: opp.sponsorId,
      sponsorName: schema.sponsor.name,
      sponsorFundId: opp.sponsorFundId,
      sponsorFundName: schema.sponsorFund.name,
      dealType: opp.dealType,
      sector: opp.sector,
      geography: opp.geography,
      stage: opp.stage,
      ownerId: opp.ownerId,
      ownerName: owner.displayName,
      receivedDate: opp.receivedDate,
      targetCommitment: opp.targetCommitment,
      currency: opp.currency,
      source: opp.source,
      passReasonCode: opp.passReasonCode,
      passNote: opp.passNote,
      investmentId: opp.investmentId,
      rowVersion: opp.rowVersion,
      stageEnteredOn,
    })
    .from(opp)
    .leftJoin(schema.sponsor, eq(schema.sponsor.id, opp.sponsorId))
    .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, opp.sponsorFundId))
    .leftJoin(owner, eq(owner.id, opp.ownerId))
    .$dynamic();
  if (opts.where !== undefined) query = query.where(opts.where);
  if (opts.orderBy !== undefined) query = query.orderBy(...opts.orderBy);
  if (opts.limit !== undefined) query = query.limit(opts.limit);
  return query;
}

/** Days in the current stage: from the day it was entered (the received date before any history) to today, never negative. */
export function daysInStage(row: LoadedOpportunity, today: string): number {
  return Math.max(0, daysBetween(row.stageEnteredOn ?? row.receivedDate, today));
}

export function toOpportunityRow(row: LoadedOpportunity, today: string): OpportunityRow {
  return {
    id: row.id,
    name: row.name,
    companyName: row.companyName,
    sponsor: { id: row.sponsorId, name: row.sponsorName ?? NOT_VISIBLE },
    sponsorFund:
      row.sponsorFundId === null
        ? null
        : { id: row.sponsorFundId, name: row.sponsorFundName ?? NOT_VISIBLE },
    dealType: row.dealType,
    sector: row.sector,
    geography: row.geography,
    stage: stageOf(row.stage),
    owner: person(row.ownerId, row.ownerName),
    receivedDate: row.receivedDate,
    targetCommitment: row.targetCommitment,
    currency: row.currency,
    daysInStage: daysInStage(row, today),
    passReasonCode: row.passReasonCode,
    investmentId: row.investmentId,
    rowVersion: row.rowVersion,
  };
}

/** The opportunity locked for a command, or 404 when the caller cannot see it. */
export async function lockOpportunity(tx: Tx, id: string): Promise<LockedOpportunity> {
  const locked = (
    await tx
      .select({
        id: opp.id,
        name: opp.name,
        companyName: opp.companyName,
        portfolioCompanyId: opp.portfolioCompanyId,
        sponsorId: opp.sponsorId,
        sponsorFundId: opp.sponsorFundId,
        dealType: opp.dealType,
        sector: opp.sector,
        geography: opp.geography,
        stage: opp.stage,
        ownerId: opp.ownerId,
        currency: opp.currency,
        passReasonCode: opp.passReasonCode,
        passNote: opp.passNote,
        investmentId: opp.investmentId,
        rowVersion: opp.rowVersion,
      })
      .from(opp)
      .where(eq(opp.id, id))
      .for('update')
  )[0];
  if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
  return locked;
}

/** The stage history oldest first: who moved the deal, when and why. */
export async function loadStageHistory(
  tx: Tx,
  opportunityId: string,
): Promise<StageHistoryEntry[]> {
  const h = schema.opportunityStageHistory;
  const rows = await tx
    .select({
      fromStage: h.fromStage,
      toStage: h.toStage,
      command: h.command,
      reason: h.reason,
      changedById: h.changedBy,
      changedByName: changer.displayName,
      changedAt: h.changedAt,
    })
    .from(h)
    .leftJoin(changer, eq(changer.id, h.changedBy))
    .where(eq(h.opportunityId, opportunityId))
    .orderBy(asc(h.changedAt), asc(h.id));
  return rows.map((r) => ({
    fromStage: r.fromStage === null ? null : stageOf(r.fromStage),
    toStage: stageOf(r.toStage),
    command: r.command,
    reason: r.reason,
    changedBy: { id: r.changedById, name: r.changedByName ?? NOT_VISIBLE },
    changedAt: r.changedAt.toISOString(),
  }));
}

/** The diligence tasks by workstream (the taxonomy's order), then as created, then by title. */
export async function loadTasks(tx: Tx, opportunityId: string): Promise<DiligenceTask[]> {
  const t = schema.diligenceTask;
  const workstream = schema.taxonomyTerm;
  const rows = await tx
    .select({
      id: t.id,
      workstream: t.workstream,
      title: t.title,
      ownerId: t.ownerId,
      ownerName: owner.displayName,
      dueDate: t.dueDate,
      status: t.status,
      requiredForIc: t.requiredForIc,
      evidenceDocumentId: t.evidenceDocumentId,
      waivedReason: t.waivedReason,
    })
    .from(t)
    .leftJoin(owner, eq(owner.id, t.ownerId))
    .leftJoin(workstream, eq(workstream.code, t.workstream))
    .where(eq(t.opportunityId, opportunityId))
    .orderBy(asc(workstream.sortOrder), asc(t.createdAt), asc(t.title), asc(t.id));
  return rows.map((r) => ({
    id: r.id,
    workstream: r.workstream,
    title: r.title,
    owner: person(r.ownerId, r.ownerName),
    dueDate: r.dueDate,
    status: diligenceTaskStatus.parse(r.status),
    requiredForIc: r.requiredForIc,
    evidenceDocumentId: r.evidenceDocumentId,
    waivedReason: r.waivedReason,
  }));
}

/** The IC decisions, latest first: the first row is the one the gate reads. */
export async function loadIcDecisions(tx: Tx, opportunityId: string): Promise<IcDecision[]> {
  const d = schema.icDecision;
  const rows = await tx
    .select({
      id: d.id,
      decisionDate: d.decisionDate,
      decision: d.decision,
      amount: d.amount,
      conditions: d.conditions,
      recordedById: d.recordedBy,
      recordedByName: recorder.displayName,
    })
    .from(d)
    .leftJoin(recorder, eq(recorder.id, d.recordedBy))
    .where(eq(d.opportunityId, opportunityId))
    .orderBy(desc(d.decisionDate), desc(d.createdAt), desc(d.id));
  return rows.map((r) => ({
    id: r.id,
    decisionDate: r.decisionDate,
    decision: icDecisionOutcome.parse(r.decision),
    amount: r.amount,
    conditions: Array.isArray(r.conditions) ? r.conditions.map(String) : [],
    recordedBy: { id: r.recordedById, name: r.recordedByName ?? NOT_VISIBLE },
  }));
}
