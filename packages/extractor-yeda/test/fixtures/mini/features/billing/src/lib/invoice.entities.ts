import { defineEntity, withProjection, withSchema } from '@/platform/entities';
import { defineProjection } from '@/platform/projection-contracts';
import { Invoice } from '@/billing/contracts';
import { OrderCancelled, OrderPlaced, OrderRefunded, OrderShipped } from '@/orders/contracts';
import { invoices } from './billing.schema';

/** Follows every order event from the neighbouring feature. */
export const invoiceEntity = defineEntity(
  'invoice',
  withSchema(Invoice),
  withProjection(defineProjection({ key: 'billing.invoices', row: Invoice }), {
    events: [OrderPlaced, OrderShipped, OrderCancelled, OrderRefunded],
    consumerName: 'billing-invoices-1',
    handle: async (event: any, { db }: any) => {
      await db.update(invoices).set({ state: 'charged' });
    },
  }),
);
