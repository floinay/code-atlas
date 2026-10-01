import { loadAggregate } from '@/platform/event-store-aggregate';
import { OrderAggregate } from './order.aggregate';

export type OrdersRuntime = {
  client: any;
  identity: { find(id: string): Promise<unknown>; disable(id: string): Promise<void> };
  reserve: (orderId: string) => Promise<void>;
};

/** Every command goes through this, so the walk has to follow it. */
export async function requireOrder(runtime: Pick<OrdersRuntime, 'client'>, orderId: string) {
  const loaded = await loadAggregate({ client: runtime.client, definition: OrderAggregate, aggregateId: orderId });
  if (!loaded.state) throw new Error('order-not-found');
  return loaded;
}

export function identityClient(api: (path: string, body?: unknown) => Promise<unknown>) {
  return {
    async find(id: string) {
      return api(`/users/${id}`);
    },
    async disable(id: string) {
      await api(`/users/${id}/disable`, {});
    },
  };
}
