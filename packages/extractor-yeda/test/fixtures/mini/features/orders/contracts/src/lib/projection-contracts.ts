import { defineEntity, withEntityPermissions, withProjection, withSchema } from '@/platform/entities';
import { defineLiveProjection, defineProjection, defineSyncRoute } from '@/platform/projection-contracts';
import { OrderListItem, OrderPermissions } from './orders-contracts';

export const OrdersProjection = defineProjection({
  key: 'orders.orders',
  row: OrderListItem,
  search: ['id', 'customerId'],
});
export const OrdersLiveProjection = defineLiveProjection({
  key: 'orders.orders',
  syncRoute: defineSyncRoute({ name: 'sync.orders', path: '/sync/orders' }),
  collection: { definition: OrdersProjection, generation: 1 },
  permission: OrderPermissions.read,
  description: 'Live stream of orders',
});
/** The contract half of the entity: no handler here. */
export const orderEntity = defineEntity(
  'order',
  withSchema(OrderListItem),
  withEntityPermissions('read'),
  withProjection(OrdersLiveProjection),
);
