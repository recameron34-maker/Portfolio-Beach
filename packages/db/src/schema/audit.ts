import { bigint, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

/** Append-only (SEC-11.1). The database rejects UPDATE and DELETE for every role. */
export const auditEvent = audit.table('event', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorId: uuid('actor_id'),
  actorType: text('actor_type').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  beforeHash: text('before_hash'),
  afterHash: text('after_hash'),
  reason: text('reason'),
  requestId: text('request_id'),
  details: jsonb('details').notNull().default({}),
});
