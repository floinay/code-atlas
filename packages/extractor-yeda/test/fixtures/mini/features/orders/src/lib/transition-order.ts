import { OrderCancelled, OrderRefunded, OrderShipped } from '@/orders/contracts';
import { requireOrder, type OrdersRuntime } from './runtime';

const drafts = {
  ship: (orderId: string) => OrderShipped.draft({ orderId }),
  cancel: (orderId: string) => OrderCancelled.draft({ orderId, reason: 'customer' }),
  refund: (orderId: string) => OrderRefunded.draft({ orderId }),
};

export async function transitionOrder(runtime: OrdersRuntime, command: keyof typeof drafts, orderId: string) {
  const loaded = await requireOrder(runtime, orderId);
  await runtime.client.appendToStream({
    aggregateType: 'Order',
    aggregateId: orderId,
    expectedRevision: loaded.revision,
    events: [drafts[command](orderId)],
  });
  return loaded.state;
}
