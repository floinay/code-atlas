import * as c from '@/orders/contracts';
import { ReserveFunds } from '@/billing/contracts';
import { defineFeature, localRoute, withEntities, withRoutes, withStart } from '@/platform/backend';
import { createZitadelApi } from '@/platform/zitadel';
import { expireOrders } from './expire-orders';
import { orderEntity } from './order.entities';
import { orderNotes, readOrders } from './orders.schema';
import { placeOrder } from './place-order';
import { identityClient, requireOrder, type OrdersRuntime } from './runtime';
import { transitionOrder } from './transition-order';

const commands = ['ship', 'cancel', 'refund'] as const;

export function createOrdersFeature() {
  let runtime: OrdersRuntime;
  let db: any;

  const transitions = (routes: typeof c.OrderTransitions) =>
    commands.map((command) =>
      localRoute(routes[command], async (input: any) => ({
        status: 200 as const,
        body: await transitionOrder(runtime, command, input.orderId),
      })),
    );

  return defineFeature('orders', () => [
    withEntities(orderEntity),
    withRoutes([
      localRoute(c.PlaceOrder, async (input: any) => ({ status: 201 as const, body: await placeOrder(runtime, input) })),
      ...transitions(c.OrderTransitions),
      localRoute(c.GetOrder, async (input: any, ctx: any) => {
        if (!(await ctx.access.can(c.OrderPermissions.read))) throw new Error('denied');
        return { status: 200 as const, body: (await requireOrder(runtime, input.orderId)).state };
      }),
      localRoute(c.ListOrders, async (input: any) => {
        // Defined and never called: it must not make this query read the notes table.
        const notes = () => db.select().from(orderNotes);
        const items = await db.select().from(readOrders).limit(input.limit);
        return { status: 200 as const, body: { items } };
      }),
      localRoute(c.CheckOrder, async (input: any) => {
        const { id, status } = (await requireOrder(runtime, input.orderId)).state;
        return { status: 200 as const, body: { id, status } };
      }),
    ]),
    withStart(({ router, invoke, database }: any) => {
      db = database.db;
      runtime = {
        client: router.client,
        identity: identityClient(createZitadelApi({ issuer: 'https://id.example' })),
        reserve: async (orderId) => {
          await invoke(ReserveFunds, { orderId });
        },
      };
      let stopped = false;
      const running = (async () => {
        while (!stopped) {
          await expireOrders(runtime, db);
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
      })();
      return { close: async () => { stopped = true; await running; } };
    }),
  ]);
}
export const ordersFeature = createOrdersFeature();
