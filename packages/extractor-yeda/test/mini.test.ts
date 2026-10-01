import { buildView, lineage } from '@code-atlas/model';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createYedaExtractor, detectYeda } from '../src/index.ts';
import { miniRoot, reader } from './helpers.ts';

const { model, stats } = createYedaExtractor(miniRoot).extract();
const r = reader(model);

describe('mini repository', () => {
  it('is detected as Yeda', () => {
    expect(detectYeda(miniRoot)).toBe(true);
  });

  it('maps feature folders to domains and reads their description', () => {
    expect(model.domains.map((d) => d.id)).toEqual(['billing', 'orders']);
    expect(model.domains.find((d) => d.id === 'orders')).toMatchObject({
      name: 'Orders',
      path: 'features/orders',
      description: 'Takes orders and tracks them until they ship.',
    });
  });

  it('finds every kind of element', () => {
    expect(r.kinds('orders')).toEqual({
      event: 4, aggregate: 1, table: 2, projection: 1, subscription: 1, worker: 1, command: 4, query: 3,
    });
    expect(r.kinds('billing')).toEqual({ table: 1, projection: 1, command: 1, query: 4 });
    expect(stats.skipped).toEqual([]);
  });

  it('gives every element and edge evidence that exists', () => {
    for (const item of [...model.elements, ...model.edges]) {
      expect(existsSync(`${miniRoot}/${item.evidence.file}`), item.evidence.file).toBe(true);
      expect(item.evidence.line).toBeGreaterThan(0);
    }
  });
});

describe('routes', () => {
  it('reads HTTP through a helper and the permission from withPermission', () => {
    const place = r.find('command', 'orders.place');
    expect(place.http).toEqual({ method: 'POST', path: '/api/orders/place' });
    expect(place.permission).toBe('orders.manage');
    expect(place.description).toBe('Places an order and reserves the money for it.');
    expect(place.evidence.file).toBe('features/orders/contracts/src/lib/orders-contracts.ts');
  });

  it('expands a route factory called with different prefixes', () => {
    expect(r.labels('billing', 'query')).toEqual([
      'admin.invoices.get', 'admin.invoices.list', 'invoices.get', 'invoices.list',
    ]);
    expect(r.find('query', 'billing.admin.invoices.get').http?.path).toBe('/api/admin/billing/invoices/get');
  });

  it('leaves in-process contracts without HTTP', () => {
    expect(r.find('query', 'orders.check').http).toBeUndefined();
  });

  it('takes a permission checked in the handler when the route declares none', () => {
    expect(r.find('query', 'orders.get').permission).toBe('orders.read');
  });

  it('is a query when the handler only loads and reads, a command otherwise', () => {
    expect(r.labels('orders', 'command')).toEqual(['cancel', 'place', 'refund', 'ship']);
    expect(r.labels('orders', 'query')).toEqual(['check', 'get', 'list']);
    // No events here: writing a table is what makes it a command.
    expect(r.find('command', 'billing.reserve').appends).toEqual([]);
  });

  it('reads input, responses and error codes from the Zod schemas', () => {
    const place = r.find('command', 'orders.place');
    expect(place.input?.fields?.map((f) => f.name)).toEqual(['…', 'requestId']);
    expect(place.input?.fields?.[0]).toMatchObject({ type: 'OrderFields', refs: ['OrderFields'] });
    expect(place.responses).toEqual([{ status: 201, body: { type: 'Order', refs: ['Order'] } }]);
    expect(place.errors).toEqual({
      statuses: [404, 409],
      codes: ['order-not-found', 'order-closed', 'orders-unavailable'],
    });
    const list = r.find('query', 'orders.list');
    expect(list.input?.fields).toEqual([
      { name: 'status', type: 'OrderStatus', optional: true, refs: ['OrderStatus'] },
      { name: 'limit', type: 'int', optional: false, note: '1–100, default 20', refs: [] },
    ]);
    // Route.input and Schema.pick are resolved, not printed as code.
    const check = r.find('query', 'orders.check');
    expect(check.input?.type).toBe('{ orderId }');
    expect(check.responses[0]?.body.fields?.map((f) => f.name)).toEqual(['id', 'status']);
  });
});

describe('types', () => {
  it('names object schemas, inlines scalars and keeps an alias under its first name', () => {
    expect(Object.keys(model.types)).toEqual(['Invoice', 'Order', 'OrderError', 'OrderFields', 'OrderLine', 'OrderStatus']);
    expect(model.types['Order']?.fields?.map((f) => `${f.name}: ${f.type}`)).toEqual([
      '…: OrderFields', 'id: uuidv7', 'status: OrderStatus', 'placedAt: datetime',
    ]);
    expect(model.types['OrderFields']?.fields).toEqual([
      { name: 'customerId', type: 'string', optional: false, note: '≥ 1', refs: [] },
      { name: 'lines', type: 'OrderLine[]', optional: false, note: '1–50', refs: ['OrderLine'] },
      { name: 'note', type: 'string', optional: true, note: '≤ 500', refs: [] },
    ]);
    expect(model.types['OrderStatus']?.alias).toBe("'placed' | 'paid' | 'shipped' | 'cancelled'");
    // OrderListItem = Order
    expect(r.find('subscription', 'sync.orders').row).toEqual({ type: 'Order', refs: ['Order'] });
  });
});

describe('write model', () => {
  it('reads aggregates from their contract', () => {
    const order = r.find('aggregate', 'Order');
    expect(order.state).toEqual({ type: 'Order | null', refs: ['Order'] });
    expect(order.storage).toEqual({ kind: 'event-store', stream: 'Order', snapshot: true });
    expect(r.out(order.id, 'emits')).toEqual(['orders.cancelled', 'orders.placed', 'orders.refunded', 'orders.shipped']);
  });

  it('resolves an event identity that is spread from a constant', () => {
    const cancelled = r.find('event', 'orders.cancelled');
    expect(cancelled.schemaVersion).toBe(1);
    expect(cancelled.payload?.fields?.map((f) => f.name)).toEqual(['orderId', 'reason']);
  });

  it('records exactly the events each command appends', () => {
    expect(r.names(r.find('command', 'orders.place').appends)).toEqual(['orders.placed']);
    // One handler serves three routes; the event depends on the route.
    expect(r.names(r.find('command', 'orders.ship').appends)).toEqual(['orders.shipped']);
    expect(r.names(r.find('command', 'orders.cancel').appends)).toEqual(['orders.cancelled']);
    expect(r.names(r.find('command', 'orders.refund').appends)).toEqual(['orders.refunded']);
    expect(r.out(r.find('command', 'orders.ship').id, 'decides')).toEqual(['Order']);
  });

  it('finds background loops that append events', () => {
    const worker = r.find('worker', 'expireOrders');
    expect(worker).toMatchObject({ label: 'expire orders', trigger: 'loop', description: 'Cancels orders nobody paid for.' });
    expect(r.names(worker.appends)).toEqual(['orders.cancelled']);
    expect(worker.evidence.file).toBe('features/orders/src/lib/expire-orders.ts');
  });
});

describe('read model', () => {
  it('prefers the entity with a handler over its contract twin', () => {
    const orders = r.find('projection', 'orders.orders');
    expect(orders.evidence.file).toBe('features/orders/src/lib/order.entities.ts');
    expect(orders.entity).toEqual({
      name: 'order',
      permissions: ['read'],
      row: { type: 'Order', refs: ['Order'] },
      consumer: 'orders-projections-orders-1',
      search: ['id', 'customerId'],
    });
    expect(orders.label).toBe('Orders');
  });

  it('links events through spreads, the table a handler writes and the live stream', () => {
    const orders = r.find('projection', 'orders.orders');
    expect(r.into(orders.id, 'handles')).toEqual(['orders.cancelled', 'orders.placed', 'orders.shipped']);
    expect(r.out(orders.id, 'writes')).toEqual(['orders.read_orders']);
    expect(r.out(orders.id, 'streams')).toEqual(['sync.orders']);
    expect(r.find('subscription', 'sync.orders')).toMatchObject({ path: '/sync/orders', permission: 'orders.read' });
  });

  it('reads tables as real tables', () => {
    const table = r.find('table', 'orders.read_orders');
    expect(table.schema).toBe('orders');
    expect(table.columns).toEqual([
      { name: 'generation', type: 'integer', primaryKey: true, notNull: true },
      { name: 'id', type: 'text', primaryKey: true, notNull: true },
      { name: 'customer_id', type: 'text', primaryKey: false, notNull: true },
      { name: 'status', type: 'text', primaryKey: false, notNull: true },
      { name: 'value', type: 'jsonb', primaryKey: false, notNull: true, note: 'Order' },
    ]);
    expect(table.primaryKey).toEqual(['generation', 'id']);
    expect(table.indexes).toEqual([{ name: 'read_orders_customer', columns: ['customer_id', 'status'], unique: false }]);
    expect(table.description).toBe('One row per order, for listing.');
  });

  it('draws reads from aggregates and tables into queries only', () => {
    expect(r.into(r.find('query', 'orders.get').id, 'reads')).toEqual(['Order']);
    expect(r.into(r.find('query', 'orders.list').id, 'reads')).toEqual(['orders.read_orders']);
    // A closure that is defined but never called leaves no edge.
    expect(r.edges({ source: r.find('table', 'orders.notes').id })).toEqual([]);
    // Commands load aggregates too; that is `decides`, not `reads`.
    expect(r.into(r.find('command', 'orders.place').id, 'reads')).toEqual([]);
  });

  it('works for plain CRUD: command → table → query', () => {
    const invoices = r.find('table', 'billing.invoices');
    expect(r.out(r.find('command', 'billing.reserve').id, 'writes')).toEqual(['billing.invoices']);
    expect(r.out(invoices.id, 'reads')).toEqual([
      'billing.admin.invoices.get', 'billing.admin.invoices.list', 'billing.invoices.get', 'billing.invoices.list',
    ]);
  });
});

describe('across domains', () => {
  it('links events another feature consumes', () => {
    const invoices = r.find('projection', 'billing.invoices');
    expect(r.into(invoices.id, 'handles')).toEqual([
      'orders.cancelled', 'orders.placed', 'orders.refunded', 'orders.shipped',
    ]);
  });

  it('links routes called through invoke and context.call', () => {
    expect(r.out(r.find('command', 'orders.place').id, 'calls')).toEqual(['ZITADEL', 'billing.reserve']);
    expect(r.out(r.find('command', 'billing.reserve').id, 'calls')).toEqual(['orders.check']);
  });

  it('finds external systems behind a client built at start', () => {
    const zitadel = r.find('external', 'ZITADEL');
    expect(zitadel).toMatchObject({ domain: null, system: 'system' });
    expect(r.into(zitadel.id, 'calls')).toEqual(['expireOrders', 'orders.place']);
    // `find` only reads, so it does not turn a query into a command; `disable` in the worker writes.
    expect(r.edges({ target: zitadel.id })[0]?.evidence.file).toBe('features/orders/src/lib/runtime.ts');
  });
});

describe('checks and view', () => {
  it('warns about the event a projection forgot', () => {
    expect(model.checks).toHaveLength(1);
    expect(model.checks[0]).toMatchObject({
      rule: 'unhandled-event',
      element: r.find('event', 'orders.refunded').id,
      missing: [r.find('projection', 'orders.orders').id],
      detail: { event: 'refunded', aggregate: 'Order', consumers: ['Orders'], handledSiblings: 3 },
    });
  });

  it('bundles the factory routes and follows lineage end to end', () => {
    const view = buildView(model);
    const get = view.byId.get(view.nodeOf.get(r.find('query', 'billing.invoices.get').id)!)!;
    expect(get.members.map((m) => m.name)).toEqual(['billing.invoices.get', 'billing.admin.invoices.get']);
    const { nodes } = lineage(view, r.find('command', 'orders.ship').id);
    const labels = [...nodes].map((id) => view.byId.get(id)!.label);
    expect(labels).toEqual(expect.arrayContaining(['Order', 'shipped', 'Orders', 'read_orders', 'sync.orders', 'Invoices', 'list']));
    expect(labels).not.toContain('refunded');
  });
});

describe('incremental', () => {
  it('re-reads only what was invalidated and returns the same model', () => {
    const extractor = createYedaExtractor(miniRoot);
    const first = extractor.extract().model;
    extractor.invalidate(['features/orders/src/lib/orders.ts']);
    expect(extractor.extract().model).toEqual(first);
  });
});
