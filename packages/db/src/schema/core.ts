import {
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from './columns.js';

export const core = pgSchema('core');

export const appUser = core.table('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: text('external_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  ...standardColumns,
});

export const taxonomyTerm = core.table('taxonomy_term', {
  domain: text('domain').notNull(),
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  parentCode: text('parent_code'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...standardColumns,
});

export const sponsor = core.table('sponsor', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  canonicalName: text('canonical_name').notNull().unique(),
  tier: text('tier').notNull(),
  hqGeography: text('hq_geography'),
  description: text('description'),
  ...standardColumns,
});

export const sponsorFund = core.table('sponsor_fund', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorId: uuid('sponsor_id').notNull(),
  name: text('name').notNull(),
  canonicalName: text('canonical_name').notNull().unique(),
  vintage: integer('vintage'),
  strategy: text('strategy'),
  sizeTarget: numeric('size_target', { precision: 20, scale: 2 }),
  sizeHardCap: numeric('size_hard_cap', { precision: 20, scale: 2 }),
  sizeFinal: numeric('size_final', { precision: 20, scale: 2 }),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  ...standardColumns,
});

export const fundAlias = core.table('fund_alias', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorFundId: uuid('sponsor_fund_id').notNull(),
  alias: text('alias').notNull().unique(),
  ...standardColumns,
});

export const portfolioCompany = core.table('portfolio_company', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  canonicalName: text('canonical_name').notNull().unique(),
  sector: text('sector'),
  geography: text('geography'),
  description: text('description'),
  ...standardColumns,
});

export const fundHolding = core.table('fund_holding', {
  id: uuid('id').primaryKey().defaultRandom(),
  sponsorFundId: uuid('sponsor_fund_id').notNull(),
  portfolioCompanyId: uuid('portfolio_company_id').notNull(),
  ...standardColumns,
});

export const vehicle = core.table('vehicle', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  vehicleType: text('vehicle_type').notNull(),
  vintage: integer('vintage'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  closingCount: integer('closing_count').notNull().default(0),
  finalCloseDate: date('final_close_date'),
  ...standardColumns,
});

export const investment = core.table('investment', {
  id: uuid('id').primaryKey().defaultRandom(),
  investmentNumber: text('investment_number').notNull().unique(),
  vehicleId: uuid('vehicle_id').notNull(),
  portfolioCompanyId: uuid('portfolio_company_id').notNull(),
  sponsorFundId: uuid('sponsor_fund_id'),
  sponsorId: uuid('sponsor_id').notNull(),
  dealType: text('deal_type').notNull(),
  entryDate: date('entry_date').notNull(),
  exitDate: date('exit_date'),
  isActive: boolean('is_active').notNull().default(true),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  ...standardColumns,
});

export const client = core.table('client', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  reportingBases: jsonb('reporting_bases').notNull().default([]),
  reportingCadence: text('reporting_cadence').notNull().default('quarterly'),
  ...standardColumns,
});

export const commitment = core.table('commitment', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull(),
  sponsorFundId: uuid('sponsor_fund_id').notNull(),
  clientId: uuid('client_id'),
  amount: numeric('amount', { precision: 20, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  commitmentDate: date('commitment_date').notNull(),
  sideLetterFlags: jsonb('side_letter_flags').notNull().default({}),
  ...standardColumns,
});

export const lpCommitment = core.table('lp_commitment', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull(),
  vehicleId: uuid('vehicle_id').notNull(),
  amount: numeric('amount', { precision: 20, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  commitmentDate: date('commitment_date').notNull(),
  closingNumber: integer('closing_number').notNull().default(1),
  ownershipPct: numeric('ownership_pct', { precision: 12, scale: 8 }),
  sideLetterFlags: jsonb('side_letter_flags').notNull().default({}),
  ...standardColumns,
});

export const matchGuard = core.table('match_guard', {
  id: uuid('id').primaryKey().defaultRandom(),
  nameA: text('name_a').notNull(),
  nameB: text('name_b').notNull(),
  reason: text('reason').notNull(),
  ...standardColumns,
});

export const wall = core.table('wall', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  ...standardColumns,
});

export const wallMember = core.table(
  'wall_member',
  {
    wallId: uuid('wall_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [primaryKey({ columns: [t.wallId, t.userId] })],
);

export const walledRecord = core.table(
  'walled_record',
  {
    wallId: uuid('wall_id').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [primaryKey({ columns: [t.entity, t.entityId, t.wallId] })],
);
