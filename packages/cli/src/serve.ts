import {
  applyBaseline,
  diffModels,
  findingKeys,
  isEmptyDiff,
  parseState,
  project,
  pruneBaseline,
  viewKey,
  type AtlasState,
  type ClientMessage,
  type DomainsConfig,
  type FeedEntry,
  type Layout,
  type Model,
  type ModelDiff,
  type ServerMessage,
  type View,
} from '@code-atlas/model';
import { watch } from 'chokidar';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import launchEditor from 'launch-editor';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ADAPTERS, Extractor } from './adapters.ts';
import { CONFIG_DIR, DOMAINS_FILE, loadDomainsConfig } from './config.ts';
import { assertDomains, extractFull } from './pipeline.ts';

export type ServeOptions = {
  root: string;
  adapter: (typeof ADAPTERS)[number];
  config: DomainsConfig;
  port: number;
  /** The interface to listen on. Default: `127.0.0.1`, this machine only. */
  host?: string;
  open?: boolean;
  /** Domains to draw in full for this run, from `--only`. */
  explore?: string[];
  /** The domains file, when it is not `<repo>/.code-atlas/domains.yaml`. */
  configFile?: string;
  /** The command that opens a file in an editor. Default: the editor that is running. */
  editor?: string;
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
  /** The domains drawn in full, or undefined when all of them are. */
  explored(): string[] | undefined;
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
  const extract = () => extractFull(root, extractor, config);

  const first = extract();
  if (options.explore) assertDomains(options.explore, first.model);
  if (config.explore) assertDomains(config.explore, first.model);
  const raw = readJson(layoutFile);
  // The command line speaks for this run, the saved choice for the last one, the config for the repository.
  let wanted: readonly string[] | undefined = options.explore ?? parseState(raw).explore ?? config.explore;
  let state: AtlasState = parseState(raw, viewKey(project(first.model, wanted, parseState(undefined)).explore));
  let baseline: Set<string> | undefined = state.baseline ? new Set(state.baseline) : undefined;

  const keepsBaseline = () => config.checks?.mode !== 'all';
  /** Marks the findings that were already there, and forgets the ones that were fixed. */
  const judge = (extracted: Model): Model => {
    if (!keepsBaseline()) return extracted;
    baseline = baseline ? pruneBaseline(extracted.checks, baseline) : new Set(extracted.checks.flatMap(findingKeys));
    return { ...extracted, checks: applyBaseline(extracted.checks, baseline) };
  };

  let full = judge(first.model);
  let model!: Model;
  let view!: View;
  let layout!: Layout;
  let explore: string[] | undefined;
  /** Collapses, lays out and saves: after an extraction, a change of view or a change to the baseline. */
  const show = () => {
    const projection = project(full, wanted, state);
    ({ model, view, layout, explore } = projection);
    const { baseline: _old, ...rest } = projection.state;
    state = { ...rest, ...(baseline ? { baseline: [...baseline].sort() } : {}) };
    saveState(layoutFile, state);
  };
  show();
  let feed: FeedEntry[] = [
    { at: now(), kind: 'info', subject: { type: 'watching', pattern: extractor.watch.join(', ') }, file: `watch: ${extractor.watch.join(', ')}` },
    {
      at: now(),
      kind: 'info',
      subject: {
        type: 'extracted',
        domains: full.domains.length,
        elements: full.elements.filter((e) => e.kind !== 'external').length,
        edges: view.edges.length,
        ms: first.stats.ms,
      },
      file: full.domains.map((d) => d.path).slice(0, 4).join(' · ') + (full.domains.length > 4 ? ' · …' : ''),
    },
  ];
  log(
    `${adapter.name}: ${full.domains.length} domains, ${full.elements.length} elements, ${view.edges.length} edges ` +
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
  const snapshot = (): ServerMessage => ({ type: 'model', model, layout, diff: emptyDiff, feed, baseline: keepsBaseline() });

  const host = options.host ?? '127.0.0.1';
  const exposed = !LOOPBACK.has(host);
  /**
   * The map shows a private repository and can start an editor, so a page on
   * another site must not reach it: the request has to be addressed to this
   * machine and, when a browser sent it, come from a page this server served.
   */
  const trusted = (request: IncomingMessage) => {
    const to = hostnameOf(request.headers.host);
    if (!to || (!exposed && !LOOPBACK.has(to))) return false;
    const from = request.headers.origin;
    if (!from) return true;
    const origin = hostnameOf(from);
    return origin === to || (!!origin && LOOPBACK.has(origin) && LOOPBACK.has(to));
  };

  const http = createServer((request, response) => {
    if (trusted(request)) return void handle(request, response);
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Code Atlas only answers requests made from its own page.\n');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', verifyClient: ({ req }: { req: IncomingMessage }) => trusted(req) });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.on('message', (data) => {
      try {
        receive(JSON.parse(String(data)) as ClientMessage);
      } catch (error) {
        log(`ignored a message from the browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    send(socket, snapshot());
  });

  /** A choice made in the browser. Every open page gets the result, so they stay the same map. */
  function receive(message: ClientMessage) {
    if (message.type === 'explore') {
      const domains = message.domains;
      if (domains !== null && !(Array.isArray(domains) && domains.every((id) => typeof id === 'string'))) return;
      wanted = domains ?? [];
      // An empty list is "all of them, and I chose so": it outlives the config's default.
      state = { ...state, explore: project(full, wanted, state).explore ?? [] };
    } else if (message.type === 'check') {
      const check = full.checks.find((c) => c.id === message.id);
      if (!check || !baseline) return;
      for (const key of findingKeys(check)) {
        if (message.known) baseline.add(key);
        else baseline.delete(key);
      }
      full = { ...full, checks: applyBaseline(full.checks, baseline) };
    } else return;
    show();
    // Nothing happened in the code, so the feed has nothing to add.
    broadcast({ ...snapshot(), feed: [] });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': TYPES['.json']!, 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/health') return json({ ok: true, adapter: adapter.name, repo: model.repo.name });
    if (url.pathname === '/api/model') return json(model);
    if (url.pathname === '/api/state') return json(snapshot());
    if (url.pathname === '/api/open') {
      // A JSON body cannot be sent across sites without a preflight, which this server never answers.
      if (request.method !== 'POST' || !/^application\/json\b/.test(request.headers['content-type'] ?? ''))
        return json({ ok: false, error: 'POST application/json' }, 405);
      const body = await readBody(request).catch(() => undefined);
      const file = typeof body?.file === 'string' ? resolve(root, body.file) : undefined;
      // Only files of this repository, named the way the model names them.
      if (!file || !(file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()))
        return json({ ok: false, error: 'not a file of this repository' }, 404);
      const line = Number.isInteger(body?.line) && (body!.line as number) > 0 ? (body!.line as number) : undefined;
      const error = await openInEditor(file, line, options.editor ?? process.env.CODE_ATLAS_EDITOR);
      return json(error ? { ok: false, error } : { ok: true }, error ? 500 : 200);
    }
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
        const before = JSON.stringify(config.explore);
        config = loadDomainsConfig(root, options.configFile);
        extractor = adapter.create(root, config);
        // A new `explore` in the file is a decision: it replaces what was chosen in the browser.
        if (JSON.stringify(config.explore) !== before) {
          wanted = config.explore;
          const { explore: _chosen, ...rest } = state;
          state = rest;
        }
      } else extractor.invalidate(files);
      const next = extract();
      const previous = model;
      full = judge(next.model);
      show();
      const diff = diffModels(previous, model);
      if (isEmptyDiff(diff)) {
        const entry: FeedEntry = { at, kind: 'info', subject: { type: 'files', count: files.length }, ...(shown ? { file: shown } : {}) };
        remember([entry]);
        broadcast({ type: 'feed', feed: [entry] });
        return;
      }
      const entries = describe(diff, previous, model, at);
      remember(entries);
      broadcast({ type: 'model', model, layout, diff, feed: entries, baseline: keepsBaseline() });
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

  const configFile = options.configFile ? resolve(options.configFile) : join(root, DOMAINS_FILE);
  const inRepo = (path: string) => {
    const rel = relative(root, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  const watched = [...extractor.watch.map((path) => join(root, path)), configFile];
  const watcher = watch(watched, {
    ignoreInitial: true,
    // Judged inside the repository: its own location may well be under a folder called tmp.
    ignored: (path) =>
      inRepo(path) && /(^|\/)(node_modules|dist|\.git|\.delta|coverage|tmp)(\/|$)/.test(relative(root, path).split(sep).join('/')),
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
  });
  watcher.on('all', (_event, path) => {
    const isConfig = path === configFile;
    const rel = inRepo(path) ? relative(root, path).split(sep).join('/') : path;
    if (!isConfig && !/\.(ts|mts|tsx|prisma|md)$/.test(rel)) return;
    const stamp = stampOf(path);
    if (stamps.get(rel) === stamp) return;
    stamps.set(rel, stamp);
    if (isConfig) configChanged = true;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, options.debounce ?? 120);
  });
  await new Promise<void>((done) => watcher.once('ready', () => done()));

  const port = await listen(http, options.port, host);
  const url = `http://localhost:${port}`;
  const shownLayout = relative(process.cwd(), layoutFile);
  log(`Code Atlas is at ${url}  (watching ${extractor.watch.join(', ')}; layout in ${shownLayout.startsWith('..') ? layoutFile : shownLayout})`);
  if (options.open) openBrowser(url);

  return {
    url,
    port,
    model: () => model,
    layout: () => layout,
    explored: () => explore,
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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The host name in a `Host` or `Origin` header, without the port. */
function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((done, fail) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > 4096) fail(new Error('body too large'));
    });
    request.on('error', fail);
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(text);
        done(body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined);
      } catch (error) {
        fail(error);
      }
    });
  });
}

/**
 * Opens a file at a line in the editor: the one given, else the one that is
 * running, else `$EDITOR`. Resolves with what went wrong, or with nothing.
 */
function openInEditor(file: string, line: number | undefined, editor?: string): Promise<string | undefined> {
  return new Promise((done) => {
    // An editor that starts says nothing, so no news within a moment is good news.
    const timer = setTimeout(() => done(undefined), 400);
    launchEditor(line ? `${file}:${line}` : file, editor, (_file, message) => {
      clearTimeout(timer);
      done(message ?? 'no editor found');
    });
  });
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A broken file: start over rather than fail.
    return undefined;
  }
}

function saveState(file: string, state: AtlasState) {
  const text = JSON.stringify(state, null, 1) + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      fail(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use. Pass --port to pick another.`) : error),
    );
    server.listen(port, host, () => {
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
