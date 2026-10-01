import { integer, pgSchema, text } from 'drizzle-orm/pg-core';

export const billingSchema = pgSchema('billing');
export const invoices = billingSchema.table('invoices', {
  id: text().primaryKey(),
  orderId: text('order_id').notNull(),
  amount: integer().notNull(),
  state: text().notNull(),
});
