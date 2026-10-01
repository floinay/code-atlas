import { OrderPlaced, OrderShipped } from '@/orders/contracts';
import { combine, on } from '@/platform/kafka-events';
import { sql } from 'drizzle-orm';
import { pageAudit } from './pages.schema';

declare function projectionDb(): any;

async function remember(event: any) {
  await projectionDb().insert(pageAudit).values({ id: event.eventId, order_id: event.payload.orderId, at: event.recordedAt });
}
export const auditHandlers = [on(combine(OrderPlaced, OrderShipped), (event: any) => remember(event))];

/** Drops audit rows older than a month. */
export async function pruneAudit(db: any) {
  await db.execute(sql`delete from ${pageAudit} where at < now() - interval '30 days'`);
}
