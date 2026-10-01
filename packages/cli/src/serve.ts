import {
  Layout,
  buildView,
  computeLayout,
  diffModels,
  isEmptyDiff,
  type DomainsConfig,
  type FeedEntry,
  type Model,
  type ModelDiff,
  type ServerMessage,
} from '@code-atlas/model';
import { watch } from 'chokidar';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ADAPTERS, Extractor } from './adapters.ts';
import { CONFIG_DIR, DOMAINS_FILE, loadDomainsConfig } from './config.ts';
import { runExtraction } from './pipeline.ts';

export type ServeOptions = {
  root: string;
  adapter: (typeof ADAPTERS)[number];
  config: DomainsConfig;
  port: number;
  open?: boolean;
  explore?: string[];
  /** Where the layout is kept. Default: `<repo>/.code-atlas`. */
  stateDir?: string;
  /** The built web app. Default: `apps/web/dist` next to this package. */
  webDir?: string;
  /** Milliseconds to wait for more file changes before extracting again. */
  debounce?: number;
  quiet?: boolean;
};

export type AtlasServer = {
  url: string;
  port: number;
  /** The model as it is now. */
  model(): Model;
  layout(): Layout;
  close(): Promise<void>;
};

const emptyDiff: ModelDiff = {
  addedElements: [],
  removedElements: [],
  changedElements: [],
  addedEdges: [],
  removedEdges: [],
  addedChecks: [],
};
const FEED_HISTORY = 12;
const FEED_PER_UPDATE = 8;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Extracts once, serves the web app, then follows the files: every change is
 * re-extracted, diffed against the previous model, laid out without moving
 * what was already placed, and pushed to the browser.
 */
export async function serve(options: ServeOptions): Promise<AtlasServer> {
  const { root, adapter } = options;
  const log = (line: string) => {
    if (!options.quiet) console.error(line);
  };
  const stateDir = resolve(options.stateDir ?? join(root, CONFIG_DIR));
  const layoutFile = join(stateDir, 'layout.json');
  const webDir = options.webDir ?? fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));
  const now = () => new Date().toISOString();

  let config = options.config;
  let extractor: Extractor = adapter.create(root, config);
  const extract = () => runExtraction(root, extractor, config, options.explore ? { explore: options.explore } : {});

  const first = extract();
  let model = first.model;
  let view = buildView(model);
  let layout = computeLayout(view, model.domains, readLayout(layoutFile));
  saveLayout(layoutFile, layout);
  let feed: FeedEntry[] = [
    { at: now(), kind: 'info', subject: { type: 'watching', pattern: extractor.watch.join(', ') }, file: `watch: ${extractor.watch.join(', ')}` },
    {
      at: now(),
      kind: 'info',
      subject: {
        type: 'extracted',
        domains: model.domains.length,
        elements: model.elements.filter((e) => e.kind !== 'external').length,
        edges: view.edges.length,
        ms: first.stats.ms,
      },
      file: model.domains.map((d) => d.path).slice(0, 4).join(' · ') + (model.domains.length > 4 ? ' · …' : ''),
    },
  ];
  log(
    `${adapter.name}: ${model.domains.length} domains, ${model.elements.length} elements, ${view.edges.length} edges ` +
      `from ${first.stats.files} files in ${first.stats.ms} ms`,
  );

  const sockets = new Set<WebSocket>();
  const send = (socket: WebSocket, message: ServerMessage) => socket.send(JSON.stringify(message));
  const broadcast = (message: ServerMessage) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
  };
  const remember = (entries: FeedEntry[]) => {
    feed = [...feed, ...entries].slice(-FEED_HISTORY);
  };
  const snapshot = (): ServerMessage => ({ type: 'model', model, layout, diff: emptyDiff, feed });

  const http = createServer((request, response) => handle(request, response));
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    send(socket, snapshot());
  });

  function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (body: unknown) => {
      response.writeHead(200, { 'content-type': TYPES['.json']!, 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/health') return json({ ok: true, adapter: adapter.name, repo: model.repo.name });
    if (url.pathname === '/api/model') return json(model);
    if (url.pathname === '/api/state') return json(snapshot());
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404).end();
      return;
    }
    if (!existsSync(join(webDir, 'index.html'))) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        `The web app is not built.\n\nRun \`pnpm build\` in the code-atlas repository and reload,\n` +
          `or run \`pnpm dev\` there and open http://localhost:5273 instead.\n`,
      );
      return;
    }
    // Static files, with index.html for anything that is not a file.
    const requested = resolve(webDir, `.${decodeURIComponent(url.pathname)}`);
    const inside = requested === webDir || requested.startsWith(webDir + sep);
    const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : join(webDir, 'index.html');
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    response.end(readFileSync(file));
  }

  // ---------------------------------------------------------------- watching

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let configChanged = false;
  // File systems report one save more than once. A file that looks the same as last time did not change.
  const stamps = new Map<string, string>();
  const stampOf = (path: string) => {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'gone';
    }
  };

  const update = () => {
    timer = undefined;
    const files = [...pending];
    pending.clear();
    const at = now();
    const shown = files.length === 1 ? files[0] : `${files[0]} +${files.length - 1}`;
    try {
      if (configChanged) {
        configChanged = false;
        config = loadDomainsConfig(root);
        extractor = adapter.create(root, config);
      } else extractor.invalidate(files);
      const next = extract();
      const diff = diffModels(model, next.model);
      if (isEmptyDiff(diff)) {
        const entry: FeedEntry = { at, kind: 'info', subject: { type: 'files', count: files.length }, ...(shown ? { file: shown } : {}) };
        remember([entry]);
        broadcast({ type: 'feed', feed: [entry] });
        return;
      }
      const entries = describe(diff, model, next.model, at);
      model = next.model;
      view = buildView(model);
      layout = computeLayout(view, model.domains, layout);
      saveLayout(layoutFile, layout);
      remember(entries);
      broadcast({ type: 'model', model, layout, diff, feed: entries });
      log(
        `${at.slice(11, 19)} ${shown}: +${diff.addedElements.length} −${diff.removedElements.length} ~${diff.changedElements.length} elements, ` +
          `+${diff.addedEdges.length} −${diff.removedEdges.length} edges (${next.stats.ms} ms)`,
      );
    } catch (error) {
      // A half-saved file must not take the map down: keep the last good model.
      const message = error instanceof Error ? error.message : String(error);
      const entry: FeedEntry = { at, kind: 'warn', subject: { type: 'error', message }, ...(shown ? { file: shown } : {}) };
      remember([entry]);
      broadcast({ type: 'feed', feed: [entry] });
      log(`${at.slice(11, 19)} ${shown}: ${message}`);
    }
  };

  const watched = [...extractor.watch.map((path) => join(root, path)), join(root, DOMAINS_FILE)];
  const watcher = watch(watched, {
    ignoreInitial: true,
    // Judged inside the repository: its own location may well be under a folder called tmp.
    ignored: (path) => /(^|\/)(node_modules|dist|\.git|\.delta|coverage|tmp)(\/|$)/.test(relative(root, path).split(sep).join('/')),
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
  });
  watcher.on('all', (_event, path) => {
    const rel = relative(root, path).split(sep).join('/');
    if (rel !== DOMAINS_FILE && !/\.(ts|mts|tsx|prisma|md)$/.test(rel)) return;
    const stamp = stampOf(path);
    if (stamps.get(rel) === stamp) return;
    stamps.set(rel, stamp);
    if (rel === DOMAINS_FILE) configChanged = true;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, options.debounce ?? 120);
  });
  await new Promise<void>((done) => watcher.once('ready', () => done()));

  const port = await listen(http, options.port);
  const url = `http://localhost:${port}`;
  const shownLayout = relative(process.cwd(), layoutFile);
  log(`Code Atlas is at ${url}  (watching ${extractor.watch.join(', ')}; layout in ${shownLayout.startsWith('..') ? layoutFile : shownLayout})`);
  if (options.open) openBrowser(url);

  return {
    url,
    port,
    model: () => model,
    layout: () => layout,
    async close() {
      if (timer) clearTimeout(timer);
      await watcher.close();
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

/** What changed, as feed entries: new and removed elements first, then checks. */
function describe(diff: ModelDiff, previous: Model, next: Model, at: string): FeedEntry[] {
  const before = new Map(previous.elements.map((e) => [e.id, e]));
  const after = new Map(next.elements.map((e) => [e.id, e]));
  const entries: FeedEntry[] = [];
  const element = (kind: FeedEntry['kind'], id: string, source: Map<string, Model['elements'][number]>) => {
    const found = source.get(id);
    if (found)
      entries.push({ at, kind, subject: { type: 'element', id, kind: found.kind, label: found.label }, file: found.evidence.file });
  };
  for (const id of diff.addedElements) element('add', id, after);
  for (const id of diff.removedElements) element('remove', id, before);
  for (const id of diff.changedElements) element('change', id, after);
  if (!entries.length) {
    // Only connections changed: say which.
    const edge = (kind: FeedEntry['kind'], key: string, source: Map<string, Model['elements'][number]>) => {
      const [from, relation, to] = key.split('|') as [string, string, string];
      const a = source.get(from);
      const b = source.get(to);
      if (a && b) entries.push({ at, kind, subject: { type: 'edge', source: a.label, target: b.label, kind: relation } });
    };
    for (const key of diff.addedEdges) edge('add', key, after);
    for (const key of diff.removedEdges) edge('remove', key, before);
  }
  const shown = entries.slice(0, FEED_PER_UPDATE);
  if (entries.length > shown.length)
    shown.push({ at, kind: 'info', subject: { type: 'note', text: `… +${entries.length - shown.length}` } });
  for (const id of diff.addedChecks) {
    const check = next.checks.find((c) => c.id === id);
    if (check)
      shown.push({
        at,
        kind: 'warn',
        subject: {
          type: 'check',
          event: check.detail.event,
          aggregate: check.detail.aggregate,
          consumers: check.detail.consumers,
          siblings: check.detail.handledSiblings,
        },
        ...(after.get(check.element) ? { file: after.get(check.element)!.evidence.file } : {}),
      });
  }
  return shown;
}

function readLayout(file: string): Layout | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return Layout.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // A layout from another version, or a broken file: start over rather than fail.
    return undefined;
  }
}

function saveLayout(file: string, layout: Layout) {
  const text = JSON.stringify(layout, null, 1) + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      fail(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use. Pass --port to pick another.`) : error),
    );
    server.listen(port, () => {
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
