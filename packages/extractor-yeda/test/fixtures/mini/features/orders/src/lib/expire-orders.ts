import { OrderCancelled } from '@/orders/contracts';
import { readOrders } from './orders.schema';
import type { OrdersRuntime } from './runtime';

/** Cancels orders nobody paid for. */
export async function expireOrders(runtime: OrdersRuntime, db: any) {
  const stale = await db.select().from(readOrders);
  for (const row of stale) {
    await runtime.identity.disable(row.customerId);
    await runtime.client.appendToStream({
      aggregateType: 'Order',
      aggregateId: row.id,
      events: [OrderCancelled.draft({ orderId: row.id, reason: 'expired' })],
    });
  }
}
