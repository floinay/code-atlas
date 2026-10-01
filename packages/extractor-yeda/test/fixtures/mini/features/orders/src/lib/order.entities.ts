import { defineEntity, withEntityPermissions, withProjection, withSchema } from '@/platform/entities';
import { OrderCancelled, OrderListItem, OrderPlaced, OrderShipped, OrdersLiveProjection } from '@/orders/contracts';
import { readOrders } from './orders.schema';

/** Deliberately does not handle OrderRefunded: the check should say so. */
const followed = [OrderPlaced, OrderShipped] as const;

export const orderEntity = defineEntity(
  'order',
  withSchema(OrderListItem),
  withEntityPermissions('read'),
  withProjection(OrdersLiveProjection, {
    events: [...followed, OrderCancelled],
    consumerName: 'orders-projections-orders-1',
    async handle(event: any, { db, setItem }: any) {
      await db.insert(readOrders).values({ generation: 1, id: event.payload.orderId });
      await setItem(event.payload);
    },
  }),
);
