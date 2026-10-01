import { defineAggregate } from '@/platform/event-store-aggregate';
import { OrderAggregateContract } from '@/orders/contracts';

export const OrderAggregate = defineAggregate({
  contract: OrderAggregateContract,
  snapshot: { stateSchemaVersion: 1 },
  initialState: () => null,
  evolve: (state: unknown) => state,
});
