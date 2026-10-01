import * as z from 'zod/v4';
import { defineRoute, response, withHttp } from '@/platform/route-contracts';

export const Invoice = z.strictObject({
  id: z.string(),
  orderId: z.uuidv7(),
  amount: z.int().nonnegative(),
  state: z.enum(['reserved', 'charged', 'released']),
});
const byOrder = z.strictObject({ orderId: z.uuidv7() });

/** In-process: Orders calls it while placing an order. */
export const ReserveFunds = defineRoute({ name: 'billing.reserve', input: byOrder, responses: [response(200, Invoice)] });

/** The same routes exist once per audience; only the prefix differs. */
const invoiceRoutes = (prefix: string, path: string) => {
  const http = (operation: string) => withHttp({ method: 'POST', path: `/api/${path}/${operation}` });
  return {
    get: defineRoute({ name: `${prefix}.get`, input: byOrder, responses: [response(200, Invoice)] }, http('get')),
    list: defineRoute(
      { name: `${prefix}.list`, input: z.strictObject({}), responses: [response(200, z.array(Invoice))] },
      http('list'),
    ),
  };
};
export const InvoiceRoutes = invoiceRoutes('billing.invoices', 'billing/invoices');
export const AdminInvoiceRoutes = invoiceRoutes('billing.admin.invoices', 'admin/billing/invoices');
