import { DomainsConfig, buildView, computeLayout, type ClientMessage, type ServerMessage } from '@code-atlas/model';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pickAdapter } from '../src/adapters.ts';
import { loadDomainsConfig } from '../src/config.ts';
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
    /** The next model update, skipping feed-only messages. */
    async nextModel() {
      for (;;) {
        const message = await this.next();
        if (message.type === 'model') return message;
      }
    },
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
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
    const update = await socket.nextModel();
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
    expect(JSON.parse(readFileSync(join(root, '.code-atlas', 'layout.json'), 'utf8')).views['*'].nodes[added]).toBeDefined();

    // The agent fixes the projection: the warning goes away.
    edit(root, 'features/billing/src/lib/invoice.entities.ts', (text) =>
      text
        .replace('OrderCancelled, OrderPlaced,', 'OrderCancelled, OrderDelivered, OrderPlaced,')
        .replace('events: [OrderPlaced,', 'events: [OrderDelivered, OrderPlaced,'),
    );
    const fixed = await socket.nextModel();
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
  const savedState = (root: string) => JSON.parse(readFileSync(join(root, '.code-atlas', 'layout.json'), 'utf8'));
  const refunded = 'unhandled-event:orders:event:orders.refunded';

  it('starts quiet: what was already wrong is known, and stays so until it is raised again', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    expect(server.model().checks.map((c) => [c.id, c.known])).toEqual([[refunded, true]]);
    expect(savedState(root).baseline).toHaveLength(1);

    const socket = client(server.url);
    cleanup.push(() => socket.close());
    await socket.next();
    socket.send({ type: 'check', id: refunded, known: false });
    const raised = await socket.nextModel();
    expect(raised.model.checks[0]).toMatchObject({ id: refunded, known: false });
    expect(raised.diff.addedElements).toEqual([]);
    expect(savedState(root).baseline).toEqual([]);

    socket.send({ type: 'check', id: refunded, known: true });
    expect((await socket.nextModel()).model.checks[0]!.known).toBe(true);
    await server.close();
    expect((await start(root)).model().checks[0]!.known).toBe(true);
  });

  it('raises everything when the config asks for all checks', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root, { config: DomainsConfig.parse({ checks: { mode: 'all' } }) });
    expect(server.model().checks.map((c) => c.known)).toEqual([false]);
    expect(savedState(root).baseline).toBeUndefined();
  });

  it('collapses and explores domains from the browser, one remembered layout per view', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root);
    const socket = client(server.url);
    cleanup.push(() => socket.close());
    const all = await socket.nextModel();
    expect(all.model.collapsed).toEqual([]);

    socket.send({ type: 'explore', domains: ['orders'] });
    const focused = await socket.nextModel();
    expect(focused.model.domains.map((d) => d.id)).toEqual(['orders']);
    expect(focused.model.collapsed.map((d) => d.id)).toEqual(['billing', 'pages']);
    expect(focused.diff.addedElements).toEqual([]);
    expect(focused.feed).toEqual([]);
    expect(Object.keys(focused.layout.regions)).toEqual(['orders']);
    expect(server.explored()).toEqual(['orders']);
    expect(savedState(root)).toMatchObject({ explore: ['orders'] });
    expect(Object.keys(savedState(root).views)).toEqual(['*', 'orders']);

    // A change in a collapsed domain is still extracted, and shows where the block touches the map.
    edit(root, contracts, (text) => `// nothing\n${text}`);
    expect((await socket.next()).type).toBe('feed');

    socket.send({ type: 'explore', domains: null });
    const back = await socket.nextModel();
    expect(back.layout).toEqual(all.layout);
    expect(savedState(root).explore).toEqual([]);

    socket.send({ type: 'explore', domains: ['orders', 'nope'] });
    expect((await socket.nextModel()).layout).toEqual(focused.layout);
    await server.close();
    // The choice outlives the server; --only speaks for one run and is not saved.
    expect((await start(root)).explored()).toEqual(['orders']);
    const once = await start(root, { explore: ['billing'] });
    expect(once.explored()).toEqual(['billing']);
    expect(savedState(root).explore).toEqual(['orders']);
  });

  it('keeps the positions of a layout file written by an earlier version', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const model = (await start(root, { stateDir: join(root, 'elsewhere') })).model();
    const old = computeLayout(buildView(model), model.domains);
    const moved = 'orders:event:orders.placed';
    old.nodes[moved]!.y += 300;
    old.regions['orders']!.h += 300;
    mkdirSync(join(root, '.code-atlas'));
    writeFileSync(join(root, '.code-atlas', 'layout.json'), JSON.stringify(old));
    const server = await start(root);
    expect(server.layout().nodes[moved]).toEqual(old.nodes[moved]);
    expect(savedState(root).version).toBe(2);
  });

  it('opens a file of the repository in the editor, and nothing else', async () => {
    const root = workspace();
    const out = join(mkdtempSync(join(tmpdir(), 'code-atlas-editor-')), 'opened.txt');
    const script = join(dirname(out), 'editor.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(' '));\n`);
    cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(dirname(out), { recursive: true, force: true }));
    const server = await start(root, { editor: `node ${script}` });
    const open = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.url}/api/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    const opened = await open({ file: contracts, line: 12 });
    expect(await opened.json()).toEqual({ ok: true });
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((done) => setTimeout(done, 20));
    expect(readFileSync(out, 'utf8')).toContain(join(root, contracts));

    expect((await open({ file: '../../etc/hosts' })).status).toBe(404);
    expect((await open({ file: 'features/nope.ts' })).status).toBe(404);
    expect((await open({ file: contracts }, { 'content-type': 'text/plain' })).status).toBe(405);
    // A page on another site may not use the server, whatever it asks for.
    expect((await open({ file: contracts }, { origin: 'https://example.com' })).status).toBe(403);
    expect((await fetch(`${server.url}/api/model`, { headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await fetch(`${server.url}/api/model`, { headers: { origin: server.url } })).status).toBe(200);
  });

  it('says what went wrong when the editor cannot be started', async () => {
    const root = workspace();
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const server = await start(root, { editor: 'code-atlas-no-such-editor' });
    const response = await fetch(`${server.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: contracts, line: 1 }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('code-atlas-no-such-editor') });
  });

  it('reads the domains file from where it is told, and follows it', async () => {
    const root = workspace();
    const dir = mkdtempSync(join(tmpdir(), 'code-atlas-config-'));
    const configFile = join(dir, 'domains.yaml');
    writeFileSync(configFile, 'domains:\n  orders:\n    name: Sales\n');
    cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(dir, { recursive: true, force: true }));
    const server = await start(root, { config: loadDomainsConfig(root, configFile), configFile });
    expect(server.model().domains.find((d) => d.id === 'orders')!.name).toBe('Sales');
    const socket = client(server.url);
    cleanup.push(() => socket.close());
    await socket.next();
    writeFileSync(configFile, 'explore: [billing]\n');
    for (let message = await socket.next(); server.explored() === undefined; message = await socket.next()) void message;
    expect(server.explored()).toEqual(['billing']);
    expect(existsSync(join(root, '.code-atlas', 'domains.yaml'))).toBe(false);
  });
});
