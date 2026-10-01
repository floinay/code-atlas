import { index, integer, jsonb, pgSchema, primaryKey, text } from 'drizzle-orm/pg-core';
import type { Order } from '@/orders/contracts';

export const ordersSchema = pgSchema('orders');

/** One row per order, for listing. */
export const readOrders = ordersSchema.table(
  'read_orders',
  {
    generation: integer().notNull(),
    id: text().notNull(),
    customerId: text('customer_id').notNull(),
    status: text().notNull(),
    value: jsonb().$type<Order>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.generation, t.id] }), index('read_orders_customer').on(t.customerId, t.status)],
);
/** Declared, and never used by a handler that runs. */
export const orderNotes = ordersSchema.table('notes', { id: text().primaryKey(), body: text() });
