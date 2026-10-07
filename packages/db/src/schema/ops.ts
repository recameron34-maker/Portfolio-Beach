import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns } from './columns.js';

export const ops = pgSchema('ops');

export const schemaMigration = ops.table('schema_migration', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hash: text('hash').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});

export const featureFlag = ops.table('feature_flag', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  description: text('description').notNull().default(''),
  ...standardColumns,
});

export const task = ops.table('task', {
  id: uuid('id').primaryKey().defaultRandom(),
  regardingEntity: text('regarding_entity').notNull(),
  regardingId: uuid('regarding_id'),
  title: text('title').notNull(),
  ownerId: uuid('owner_id'),
  dueDate: date('due_date'),
  state: text('state').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  ...standardColumns,
});

export const dataException = ops.table('data_exception', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  ruleId: text('rule_id').notNull(),
  expected: text('expected'),
  actual: text('actual'),
  severity: text('severity').notNull(),
  ownerId: uuid('owner_id'),
  state: text('state').notNull().default('open'),
  externalTicket: text('external_ticket'),
  candidates: jsonb('candidates').notNull().default([]),
  ...standardColumns,
});

export const job = ops.table('job', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobType: text('job_type').notNull(),
  requestedBy: uuid('requested_by'),
  state: text('state').notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  resultRef: text('result_ref'),
  errorCode: text('error_code'),
  idempotencyKey: text('idempotency_key').unique(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  ...standardColumns,
});

export const systemsIssue = ops.table('systems_issue', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  problem: text('problem').notNull(),
  area: text('area').notNull(),
  severity: text('severity').notNull(),
  lane: text('lane').notNull().default('backlog'),
  decisionLog: jsonb('decision_log').notNull().default([]),
  ...standardColumns,
});

export const outbox = ops.table('outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  topic: text('topic').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});
