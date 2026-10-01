import { DomainsConfig, type ServerMessage } from '@code-atlas/model';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pickAdapter } from '../src/adapters.ts';
import { serve, type AtlasServer } from '../src/serve.ts';

const mini = fileURLToPath(new URL('../../extractor-yeda/test/fixtures/mini', import.meta.url));
const contracts = 'features/orders/contracts/src/lib/orders-contracts.ts';

/**
 * A private copy of the mini repository, so the test can edit files. It lives
 * under a folder named `tmp` on purpose: ignore rules must not look at where
 * the repository itself is.
 */
function workspace() {
  const root = join(mkdtempSync(join(tmpdir(), 'code-atlas-serve-')), 'tmp', 'repo');
  cpSync(mini, root, { recursive: true });
  return root;
}

/** A socket that queues what the server sends and hands messages out one at a time. */
function client(url: string) {
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  });
  return {
    next: () =>
      new Promise<ServerMessage>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error('no message from the server within 5 s')), 5000);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      }),
    close: () => socket.close(),
  };
}

const edit = (root: string, file: string, change: (text: string) => string) =>
  writeFileSync(join(root, file), change(readFileSync(join(root, file), 'utf8')));

describe('serve', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function start(root: string, extra: Partial<Parameters<typeof serve>[0]> = {}): Promise<AtlasServer> {
    const server = await serve({
      root,
      adapter: pickAdapter(root),
      config: DomainsConfig.parse({}),
      port: 0,
      debounce: 30,
      quiet: true,
      webDir: join(root, 'no-web-build'),
      ...extra,
    });
    cleanup.push(() => server.close());
    return server;
  }

  it('answers health, serves the state and explains a missing web build', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({ ok: true, adapter: 'yeda' });
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as ServerMessage;
    expect(state.type).toBe('model');
    const page = await fetch(server.url);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('pnpm build');
  });

  it('persists the layout and reuses it on the next start', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const first = await start(root);
    const file = join(root, '.code-atlas', 'layout.json');
    expect(existsSync(file)).toBe(true);
    const saved = readFileSync(file, 'utf8');
    const layout = first.layout();
    await first.close();
    cleanup.pop();
    const second = await start(root);
    expect(second.layout()).toEqual(layout);
    expect(readFileSync(file, 'utf8')).toBe(saved);
  });

  it('keeps the layout somewhere else when told to', async () => {
    const root = workspace();
    const state = mkdtempSync(join(tmpdir(), 'code-atlas-state-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(state, { recursive: true, force: true }));
    await start(root, { stateDir: state });
    expect(existsSync(join(state, 'layout.json'))).toBe(true);
    expect(existsSync(join(root, '.code-atlas'))).toBe(false);
  });

  it('pushes a new element without moving the ones already placed', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    const socket = client(server.url);
    cleanup.push(() => socket.close());

    const hello = await socket.next();
    if (hello.type !== 'model') throw new Error('expected the model first');
    expect(hello.diff.addedElements).toEqual([]);
    expect(hello.feed.map((f) => f.subject.type)).toEqual(['watching', 'extracted']);
    const before = hello.layout;

    // The agent adds an event to the aggregate, and forgets the projections.
    edit(root, contracts, (text) =>
      text
        .replace(
          'export const orderEvents = [',
          "export const OrderDelivered = defineEvent({ ...identity, name: 'orders.delivered', payload: byId });\nexport const orderEvents = [OrderDelivered, ",
        ),
    );
    const update = await socket.next();
    if (update.type !== 'model') throw new Error(`expected a model update, got ${update.type}`);
    const added = 'orders:event:orders.delivered';
    expect(update.diff.addedElements).toEqual([added]);
    expect(update.diff.addedEdges).toEqual([`orders:aggregate:Order|emits|${added}`]);
    expect(update.feed[0]).toMatchObject({ kind: 'add', subject: { type: 'element', label: 'delivered' }, file: contracts });

    // Nothing that was on the map moved; the new node sits below its lane.
    for (const [id, box] of Object.entries(before.nodes)) expect(update.layout.nodes[id], id).toEqual(box);
    const lane = Object.entries(before.nodes).filter(([id]) => id.startsWith('orders:event:'));
    const bottom = Math.max(...lane.map(([, box]) => box.y + box.h));
    expect(update.layout.nodes[added]!.y).toBeGreaterThan(bottom);
    expect(update.layout.nodes[added]!.x).toBe(lane[0]![1].x);

    // Billing follows every other order event, so the new one is flagged for it.
    expect(update.diff.addedChecks).toEqual([`unhandled-event:${added}`]);
    expect(update.feed.at(-1)).toMatchObject({ kind: 'warn', subject: { type: 'check', event: 'delivered', consumers: ['Invoices'] } });
    expect(JSON.parse(readFileSync(join(root, '.code-atlas', 'layout.json'), 'utf8')).nodes[added]).toBeDefined();

    // The agent fixes the projection: the warning goes away.
    edit(root, 'features/billing/src/lib/invoice.entities.ts', (text) =>
      text
        .replace('OrderCancelled, OrderPlaced,', 'OrderCancelled, OrderDelivered, OrderPlaced,')
        .replace('events: [OrderPlaced,', 'events: [OrderDelivered, OrderPlaced,'),
    );
    const fixed = await socket.next();
    if (fixed.type !== 'model') throw new Error(`expected a model update, got ${fixed.type}`);
    expect(fixed.model.checks.map((c) => c.id)).not.toContain(`unhandled-event:${added}`);
    expect(fixed.diff.addedEdges).toEqual([`${added}|handles|billing:projection:billing.invoices`]);
    expect(fixed.feed[0]).toMatchObject({ kind: 'add', subject: { type: 'edge', source: 'delivered', target: 'Invoices' } });
  });

  it('says so when files change and the map does not', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    const socket = client(server.url);
    cleanup.push(() => socket.close());
    await socket.next();
    edit(root, contracts, (text) => `// a comment changes nothing\n${text}`);
    const message = await socket.next();
    expect(message).toMatchObject({ type: 'feed', feed: [{ kind: 'info', subject: { type: 'files', count: 1 }, file: contracts }] });
  });

  it('removes what was deleted and survives a file that does not parse', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    const socket = client(server.url);
    cleanup.push(() => socket.close());
    await socket.next();
    const before = server.model().elements.length;

    edit(root, contracts, (text) => text.replace('export const GetOrder = defineRoute(', 'export const GetOrder = defineRoute(((('));
    const broken = await socket.next();
    // A syntax error mid-edit: the route is unreadable for a moment, the server keeps going.
    expect(['model', 'feed']).toContain(broken.type);

    edit(root, contracts, (text) => text.replace('defineRoute((((', 'defineRoute('));
    edit(root, 'features/orders/src/lib/orders.schema.ts', (text) => text.replace(/\/\*\* Declared[\s\S]*$/, ''));
    let last = await socket.next();
    while (server.model().elements.some((e) => e.name === 'orders.notes')) last = await socket.next();
    expect(last.type).toBe('model');
    expect(server.model().elements.length).toBe(before - 1);
    expect(server.layout().nodes['orders:table:orders.notes']).toBeUndefined();
  });
});
