import * as z from 'zod/v4';
import { defineAggregateContract, defineEvent } from '@/platform/events';
import {
  definePermission,
  defineRoute,
  response,
  withHttp,
  withMcp,
  withPermission,
} from '@/platform/route-contracts';

export const OrderId = z.uuidv7();
export const OrderStatus = z.enum(['placed', 'paid', 'shipped', 'cancelled']);
export const OrderLine = z.strictObject({
  sku: z.string().min(1).max(40),
  quantity: z.number().int().min(1).max(99),
});
export const OrderFields = z.strictObject({
  customerId: z.string().min(1),
  lines: z.array(OrderLine).min(1).max(50),
  note: z.string().max(500).optional(),
});
export const Order = OrderFields.extend({
  id: OrderId,
  status: OrderStatus,
  placedAt: z.iso.datetime(),
});
/** The same order as clients list it. */
export const OrderListItem = Order;

export const OrderError = z.strictObject({
  code: z.enum(['order-not-found', 'order-closed', 'orders-unavailable']),
});
export const orderErrors = [response(404, OrderError), response(409, OrderError)] as const;

const permission = (key: string) => definePermission(`orders.${key}`, { group: 'orders' });
export const OrderPermissions = { read: permission('read'), manage: permission('manage') };

const http = (path: string) => withHttp({ method: 'POST', path: `/api/orders/${path}` });

/** Places an order and reserves the money for it. */
export const PlaceOrder = defineRoute(
  {
    name: 'orders.place',
    input: OrderFields.extend({ requestId: z.uuidv7() }),
    responses: [response(201, Order), ...orderErrors],
  },
  http('place'),
  withPermission(OrderPermissions.manage),
);

const byId = z.strictObject({ orderId: OrderId });

/** One route per transition: same input, same response, same handler shape. */
const transition = (name: 'ship' | 'cancel' | 'refund') =>
  defineRoute(
    { name: `orders.${name}`, input: byId, responses: [response(200, Order), ...orderErrors] },
    http(name),
    withPermission(OrderPermissions.manage),
  );
export const OrderTransitions = {
  ship: transition('ship'),
  cancel: transition('cancel'),
  refund: transition('refund'),
} as const;

export const GetOrder = defineRoute(
  { name: 'orders.get', input: byId, responses: [response(200, Order), ...orderErrors] },
  http('get'),
  withMcp({ description: 'Reads one order from its event stream.', readOnly: true }),
);
export const ListOrders = defineRoute(
  {
    name: 'orders.list',
    input: z.strictObject({ status: OrderStatus.optional(), limit: z.int().min(1).max(100).default(20) }),
    responses: [response(200, z.strictObject({ items: z.array(Order) })), ...orderErrors],
  },
  http('list'),
  withPermission(OrderPermissions.read),
);
/** In-process only: other features ask whether an order exists. */
export const CheckOrder = defineRoute({
  name: 'orders.check',
  input: GetOrder.input,
  responses: [response(200, Order.pick({ id: true, status: true })), ...orderErrors],
});

const identity = { namespace: 'shop', aggregateType: 'Order', schemaVersion: 1 } as const;
export const OrderPlaced = defineEvent({ ...identity, name: 'orders.placed', payload: z.strictObject({ order: Order }) });
export const OrderShipped = defineEvent({ ...identity, name: 'orders.shipped', payload: byId });
export const OrderCancelled = defineEvent({
  ...identity,
  name: 'orders.cancelled',
  payload: byId.extend({ reason: z.enum(['customer', 'expired']) }),
});
export const OrderRefunded = defineEvent({ ...identity, name: 'orders.refunded', payload: byId });
export const orderEvents = [OrderPlaced, OrderShipped, OrderCancelled, OrderRefunded] as const;

export const OrderAggregateContract = defineAggregateContract({
  namespace: OrderPlaced.namespace,
  type: OrderPlaced.aggregateType,
  schema: Order.nullable(),
  events: orderEvents,
});
