import { pgSchema, text } from 'drizzle-orm/pg-core';

export const mailSchema = pgSchema('mail');
export const outbox = mailSchema.table('outbox', {
  id: text().primaryKey(),
  personId: text('person_id').notNull(),
  status: text().notNull(),
});
export const deliveries = mailSchema.table('deliveries', {
  id: text().primaryKey(),
  letterId: text('letter_id').notNull(),
  status: text().notNull(),
});
export const providerEvents = mailSchema.table('provider_events', {
  id: text().primaryKey(),
  kind: text().notNull(),
});
