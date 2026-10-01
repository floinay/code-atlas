import { OrderPlaced } from '@/orders/contracts';
import { requireOrder, type OrdersRuntime } from './runtime';

export async function placeOrder(runtime: OrdersRuntime, input: any) {
  const { client, reserve, identity } = runtime;
  await identity.find(input.customerId);
  const loaded = await requireOrder(runtime, input.requestId).catch(() => undefined);
  const order = { ...input, id: input.requestId, status: 'placed', placedAt: new Date().toISOString() };
  await client.appendToStream({
    aggregateType: 'Order',
    aggregateId: order.id,
    expectedRevision: loaded?.revision ?? 'no_stream',
    events: [OrderPlaced.draft({ order })],
  });
  await reserve(order.id);
  return order;
}
