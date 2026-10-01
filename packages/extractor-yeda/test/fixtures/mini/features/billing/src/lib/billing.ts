import { AdminInvoiceRoutes, InvoiceRoutes, ReserveFunds } from '@/billing/contracts';
import { CheckOrder } from '@/orders/contracts';
import { defineFeature, localRoute } from '@/platform/backend';
import { invoices } from './billing.schema';

/** Plain CRUD: no events, the table is the state. */
const invoiceHandlers = (routes: typeof InvoiceRoutes, db: any) => [
  localRoute(routes.get, async (input: any) => ({ status: 200 as const, body: await db.select().from(invoices) })),
  localRoute(routes.list, async () => ({ status: 200 as const, body: await db.select().from(invoices) })),
];

export function createBillingFeature(db: any) {
  return defineFeature({
    name: 'billing',
    routes: [
      localRoute(ReserveFunds, async (input: any, context: any) => {
        await context.call(CheckOrder, { orderId: input.orderId });
        const [row] = await db.insert(invoices).values({ id: input.orderId, state: 'reserved' }).returning();
        return { status: 200 as const, body: row };
      }),
      ...invoiceHandlers(InvoiceRoutes, db),
      ...invoiceHandlers(AdminInvoiceRoutes, db),
    ],
  });
}
export const billingFeature = createBillingFeature(undefined);
