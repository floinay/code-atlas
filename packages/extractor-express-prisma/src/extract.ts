import {
  Evaluator,
  Reach,
  TypeReader,
  callName,
  capitalize,
  emptyFacts,
  fnName,
  humanize,
  walk,
  type ExternalRule,
  type Facts,
  type FnValue,
  type Scope,
  type Value,
  type Workspace,
} from '@code-atlas/extractor-kit';
import {
  elementId,
  runChecks,
  type CommandElement,
  type Domain,
  type DomainsConfig,
  type Edge,
  type EdgeKind,
  type Element,
  type Field,
  type Model,
  type NamedType,
  type QueryElement,
  type RouteResponse,
  type TableElement,
  type TypeExpr,
  type WorkerElement,
} from '@code-atlas/model';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { parsePrismaSchema, type PrismaModel, type PrismaSchema } from './prisma.ts';

export type ExtractStats = { files: number; ms: number };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
const NESTED_WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'connectOrCreate']);
const GUARD = /^(require|ensure|authorize|authenticate|protect|guard|permit|allow|can|is[A-Z]|has[A-Z])/;
/** Folders that usually hold one module per sub-folder. */
const ROOT_CANDIDATES = ['src/modules', 'src/features', 'src/domains', 'modules', 'src/api', 'src/routes'];
const EXTERNALS: ExternalRule[] = [
  { match: /^nodemailer$/, system: 'SMTP' },
  { match: /^@sendgrid\/|^resend$|^postmark$/, system: 'Email' },
  { match: /^stripe$/, system: 'Stripe' },
  { match: /^@aws-sdk\/s3-request-presigner/, system: 'S3', direct: true },
  { match: /^@aws-sdk\//, system: 'S3' },
  { match: /^@slack\//, system: 'Slack' },
  { match: /^twilio$/, system: 'Twilio' },
  { match: /^ioredis$|^redis$/, system: 'Redis' },
  { match: /^axios$|^node:https?$|^undici$|^got$/, system: (file) => capitalize(humanize(basename(file).replace(/\.(ts|mts)$/, ''))), direct: true },
];

type RouterRef = ts.Node;
type Route = {
  router: RouterRef;
  method: string;
  path: string;
  handlers: ts.Expression[];
  node: ts.CallExpression;
  scope: Scope;
};
type Mount = { parent: RouterRef; child: RouterRef; prefix: string };
type PrismaUse = { model: PrismaModel; write: boolean; node: ts.Node };

/**
 * Reads an Express + Prisma app: routers become commands and queries, Prisma
 * models become tables, and the Prisma calls a handler reaches become the
 * edges between them. There is no event store here, so the map is
 * command → table → query.
 */
export class ExpressPrismaExtraction {
  private ev: Evaluator;
  private reach: Reach;
  private types: TypeReader;
  private schema: PrismaSchema = { models: new Map(), enums: new Map() };
  private schemaFile = 'prisma/schema.prisma';
  private byAccessor = new Map<string, PrismaModel>();
  private roots: string[];
  private elements = new Map<string, Element>();
  private edges = new Map<string, Edge>();
  private usage = new Map<string, { writes: Map<string, number>; reads: Map<string, number> }>();
  private pendingLinks: { element: string; model: PrismaModel; write: boolean; node: ts.Node }[] = [];
  readonly stats: ExtractStats = { files: 0, ms: 0 };

  constructor(
    private ws: Workspace,
    private config?: DomainsConfig,
  ) {
    const inlinable = (file: string) => !this.ws.rel(file).startsWith('..') && !file.includes('node_modules');
    this.ev = new Evaluator(ws, inlinable);
    this.reach = new Reach(this.ev, { isTable: () => false, externals: EXTERNALS });
    this.types = new TypeReader(this.ev, (file) => this.domainOf(file) ?? 'app');
    this.roots = config?.roots ?? ROOT_CANDIDATES.filter((dir) => hasFolders(this.ws.abs(dir))).slice(0, 1);
  }

  /** The module a file belongs to. Files outside every module are shared code. */
  private domainOf(file: string): string | undefined {
    const rel = this.ws.rel(file);
    for (const root of this.roots) {
      if (!rel.startsWith(`${root}/`)) continue;
      const folder = rel.slice(root.length + 1).split('/')[0]!.replace(/\.(ts|mts)$/, '');
      if (this.config?.domains[folder]?.ignore) return undefined;
      return this.config?.domains[folder]?.mergeInto ?? folder;
    }
    return undefined;
  }

  run(): Model {
    const started = performance.now();
    this.readSchema();
    const files = this.ws.listSources('.', (rel) => /^(prisma\/|generated\/|.*\.d\.ts$)/.test(rel));
    this.stats.files = files.length + 1;

    const routes: Route[] = [];
    const mounts: Mount[] = [];
    const jobs: { node: ts.CallExpression; schedule?: string; trigger: WorkerElement['trigger'] }[] = [];
    for (const file of files) {
      const source = this.ws.file(file)?.source;
      if (!source) continue;
      walk(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        this.readRouting(node, routes, mounts);
        const job = this.readJob(node);
        if (job) jobs.push(job);
      });
    }

    for (const route of routes) this.addRoute(route, mounts);
    for (const job of jobs) this.addWorker(job);
    this.addTables();
    for (const link of this.pendingLinks) {
      const table = this.tableId(link.model);
      if (link.write) this.link(link.element, table, 'writes', link.node);
      else this.link(table, link.element, 'reads', link.node);
    }

    const { types: zodTypes, rename } = this.types.finalize();
    const elements = [...this.elements.values()];
    const used = new Set(elements.map((e) => e.domain).filter((d): d is string => !!d));
    const domains = [...used].sort().map((id) => this.domain(id));
    const draft: Omit<Model, 'types'> = {
      version: 1,
      repo: { name: this.repoName(), adapter: 'express-prisma' },
      domains,
      collapsed: [],
      elements,
      edges: [...this.edges.values()].filter((e) => this.elements.has(e.source) && this.elements.has(e.target)),
      checks: [],
    };
    const model: Model = {
      ...(JSON.parse(rename(JSON.stringify(draft))) as typeof draft),
      types: { ...this.modelTypes(), ...zodTypes },
    };
    model.checks = runChecks(model);
    this.stats.ms = Math.round(performance.now() - started);
    return model;
  }

  private repoName(): string {
    try {
      const name = (JSON.parse(readFileSync(join(this.ws.root, 'package.json'), 'utf8')) as { name?: string }).name;
      if (name) return name;
    } catch {
      // No package.json: the folder name will do.
    }
    return basename(this.ws.root);
  }

  private domain(id: string): Domain {
    const override = this.config?.domains[id];
    const root = this.roots.find((r) => existsSync(this.ws.abs(`${r}/${id}`)));
    const path = root ? `${root}/${id}` : id === 'app' ? 'src' : this.schemaFile;
    return {
      id,
      name: override?.name ?? capitalize(humanize(id)),
      path,
      ...(override?.description ? { description: override.description } : {}),
    };
  }

  // ---------------------------------------------------------------- prisma

  private readSchema() {
    const candidates = [this.schemaFile, 'schema.prisma', 'src/prisma/schema.prisma', 'db/schema.prisma'];
    const found = candidates.find((path) => existsSync(this.ws.abs(path)));
    if (!found) return;
    this.schemaFile = found;
    this.schema = parsePrismaSchema(readFileSync(this.ws.abs(found), 'utf8'));
    for (const model of this.schema.models.values()) this.byAccessor.set(model.accessor, model);
  }

  private modelTypes(): Record<string, NamedType> {
    const types: Record<string, NamedType> = {};
    for (const model of this.schema.models.values())
      types[model.name] = {
        name: model.name,
        fields: model.fields,
        refs: [...new Set(model.fields.flatMap((f) => f.refs))],
        evidence: { file: this.schemaFile, line: model.line },
      };
    return types;
  }

  private tableId(model: PrismaModel): string {
    return elementId(this.tableDomain(model), 'table', model.table);
  }

  /**
   * The schema is one file for the whole app, so a table goes to the module
   * that is named after it, or else to the one that writes it most.
   */
  private tableDomains = new Map<string, string>();
  private tableDomain(model: PrismaModel): string {
    const cached = this.tableDomains.get(model.name);
    if (cached) return cached;
    const usage = this.usage.get(model.name);
    const domains = [...new Set([...this.elements.values()].map((e) => e.domain).filter((d): d is string => !!d))];
    const singular = (name: string) => name.toLowerCase().replace(/[-_]/g, '').replace(/ies$/, 'y').replace(/s$/, '');
    const top = (counts: Map<string, number> | undefined) => [...(counts ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
    const domain =
      domains.find((d) => singular(d) === model.name.toLowerCase()) ??
      domains.filter((d) => model.name.toLowerCase().startsWith(singular(d))).sort((a, b) => b.length - a.length)[0] ??
      top(usage?.writes) ??
      top(usage?.reads) ??
      'database';
    this.tableDomains.set(model.name, domain);
    return domain;
  }

  private addTables() {
    for (const model of this.schema.models.values()) {
      const domain = this.tableDomain(model);
      this.add<TableElement>({
        id: elementId(domain, 'table', model.table),
        kind: 'table',
        domain,
        name: model.table,
        label: model.table,
        ...(model.documentation ? { description: model.documentation } : {}),
        evidence: { file: this.schemaFile, line: model.line },
        columns: model.columns,
        primaryKey: model.primaryKey,
        indexes: model.indexes,
      });
    }
  }

  // ---------------------------------------------------------------- routing

  /** The router a call is made on: `Router()`, `express.Router()` or `express()`. */
  private routerOf(value: Value | undefined): RouterRef | undefined {
    if (value?.k !== 'call' || value.spec !== 'express') return undefined;
    return value.name === 'Router' || value.name === 'express' || value.name === 'default' ? value.node : undefined;
  }

  private readRouting(node: ts.CallExpression, routes: Route[], mounts: Mount[]) {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const name = callee.name.text;
    if (!METHODS.has(name) && name !== 'use') return;
    const scope = this.ev.scopeAt(node);
    let receiver = this.ev.eval(callee.expression, scope);
    // router.route('/x').get(h).post(h): the path comes from route().
    let routePath: string | undefined;
    while (receiver.k === 'call' && receiver.recv && (METHODS.has(receiver.name) || receiver.name === 'route')) {
      if (receiver.name === 'route') routePath = this.ev.str(receiver.args[0]?.());
      receiver = receiver.recv;
    }
    const router = this.routerOf(receiver);
    if (!router) return;
    const args = [...node.arguments];
    const first = args[0];
    const path = routePath ?? (first && (ts.isStringLiteral(first) || ts.isTemplateLiteral(first)) ? this.ev.str(this.ev.eval(first, scope)) : undefined);
    const rest = routePath !== undefined || path === undefined ? args : args.slice(1);

    if (name === 'use') {
      for (const argument of rest) {
        if (ts.isSpreadElement(argument)) continue;
        const child = this.routerOf(this.ev.eval(argument, scope));
        if (child && child !== router) mounts.push({ parent: router, child, prefix: path ?? '' });
      }
      return;
    }
    if (path === undefined) return;
    routes.push({ router, method: name.toUpperCase(), path, handlers: rest.filter((a): a is ts.Expression => !ts.isSpreadElement(a)), node, scope });
  }

  private fullPath(router: RouterRef, path: string, mounts: Mount[], depth = 0): string {
    const mount = mounts.find((m) => m.child === router);
    const joined = mount && depth < 8 ? this.fullPath(mount.parent, `${mount.prefix}/${path}`, mounts, depth + 1) : path;
    return ('/' + joined).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  }

  /** Middleware attached with `router.use(fn)`: it runs before every route of that router. */
  private routerMiddleware(router: RouterRef): { node: ts.Expression; scope: Scope }[] {
    const cached = this.middleware.get(router);
    if (cached) return cached;
    const found: { node: ts.Expression; scope: Scope }[] = [];
    walk(router.getSourceFile(), (node) => {
      if (!ts.isCallExpression(node) || callName(node) !== 'use' || !ts.isPropertyAccessExpression(node.expression)) return;
      const scope = this.ev.scopeAt(node);
      if (this.routerOf(this.ev.eval(node.expression.expression, scope)) !== router) return;
      for (const argument of node.arguments)
        if (!ts.isSpreadElement(argument) && !ts.isStringLiteral(argument) && !this.routerOf(this.ev.eval(argument, scope)))
          found.push({ node: argument, scope });
    });
    this.middleware.set(router, found);
    return found;
  }
  private middleware = new Map<RouterRef, { node: ts.Expression; scope: Scope }[]>();

  private addRoute(route: Route, mounts: Mount[]) {
    const path = this.fullPath(route.router, route.path, mounts);
    const file = route.node.getSourceFile().fileName;
    const domain = this.domainOf(file) ?? (this.roots.length ? 'app' : this.domainFromPath(path));
    const shared = this.routerMiddleware(route.router);
    const facts = emptyFacts();
    for (const { node, scope } of [...shared, ...route.handlers.map((node) => ({ node, scope: route.scope }))]) {
      const value = this.ev.eval(node, scope);
      if (value.k === 'fn') merge(facts, this.reach.analyze(value));
    }
    const uses = this.prismaUses(facts);
    const writesExternally = [...facts.externals.values()].some((e) => e.write);
    const kind = uses.some((u) => u.write) || writesExternally ? 'command' : 'query';

    const name = `${route.method} ${path}`;
    const handler = route.handlers.at(-1);
    // An inline handler is named after the function it hands the work to, preferably one of its own module.
    const called = facts.entries.map((e) => e.fn.node).filter((fn) => fnName(fn));
    const delegate = called.find((fn) => this.domainOf(fn.getSourceFile().fileName) === domain) ?? (shared.length ? undefined : called[0]);
    const label =
      (handler && referenceName(handler)) ??
      (delegate && fnName(delegate)) ??
      `${route.method} ${route.path === '/' ? path.split('/').slice(-1)[0] || '/' : route.path}`;
    const guards = [...shared.map((m) => m.node), ...route.handlers.slice(0, -1)].map(guardName).filter((g): g is string => !!g);
    const input = this.input(path, facts);
    const { responses, errors } = this.responses(facts);
    const description = jsDoc(route.node);
    const id = elementId(domain, kind, name);
    this.add({
      id,
      kind,
      domain,
      name,
      label,
      ...(description ? { description } : {}),
      evidence: this.ws.evidence(route.node),
      http: { method: route.method, path },
      ...(guards.length ? { permission: [...new Set(guards)].join(' + ') } : {}),
      ...(input ? { input } : {}),
      responses,
      ...(errors.statuses.length ? { errors } : {}),
      ...(kind === 'command' ? { appends: [] } : {}),
    } as CommandElement | QueryElement);
    this.linkUses(id, domain, kind === 'command', uses);
    this.linkExternals(id, facts);
  }

  /** `/api/projects/:id` → `projects`, for apps without a modules folder. */
  private domainFromPath(path: string): string {
    const segment = path.split('/').find((part) => part && part !== 'api' && !/^v\d+$/.test(part) && !part.startsWith(':'));
    return segment ?? 'app';
  }

  // ---------------------------------------------------------------- behaviour

  /** Prisma calls the walk found: `prisma.task.update(...)`, and what they include. */
  private prismaUses(facts: Facts): PrismaUse[] {
    const uses: PrismaUse[] = [];
    for (const { value, method, node } of facts.opaque) {
      if (value.k !== 'member') continue;
      const model = this.byAccessor.get(value.name);
      if (!model || (!READS.has(method) && !WRITES.has(method))) continue;
      const write = WRITES.has(method);
      uses.push({ model, write, node });
      const args = node.arguments[0];
      if (args && ts.isObjectLiteralExpression(args)) this.nestedUses(model, args, write, node, uses, 0);
    }
    return uses;
  }

  /** `include: { comments: true }` reads comments; `data: { members: { create } }` writes them. */
  private nestedUses(model: PrismaModel, literal: ts.ObjectLiteralExpression, write: boolean, node: ts.Node, uses: PrismaUse[], depth: number) {
    if (depth > 3) return;
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = property.name.getText();
      const value = property.initializer;
      if ((key === 'include' || key === 'select') && ts.isObjectLiteralExpression(value)) {
        for (const inner of value.properties) {
          if (!ts.isPropertyAssignment(inner)) continue;
          const related = this.schema.models.get(model.relations.get(inner.name.getText()) ?? '');
          if (!related) continue;
          uses.push({ model: related, write: false, node });
          if (ts.isObjectLiteralExpression(inner.initializer)) this.nestedUses(related, inner.initializer, false, node, uses, depth + 1);
        }
      }
      if (key === 'data' && write && ts.isObjectLiteralExpression(value)) {
        for (const inner of value.properties) {
          if (!ts.isPropertyAssignment(inner) || !ts.isObjectLiteralExpression(inner.initializer)) continue;
          const related = this.schema.models.get(model.relations.get(inner.name.getText()) ?? '');
          const writes = inner.initializer.properties.some((p) => NESTED_WRITES.has(p.name?.getText() ?? ''));
          if (related && writes) uses.push({ model: related, write: true, node });
        }
      }
    }
  }

  private linkUses(id: string, domain: string, isCommand: boolean, uses: PrismaUse[]) {
    for (const use of uses) {
      const entry = this.usage.get(use.model.name) ?? { writes: new Map(), reads: new Map() };
      const counts = use.write ? entry.writes : entry.reads;
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
      this.usage.set(use.model.name, entry);
      // A command reads before it writes; only what it changes is drawn. A query only reads.
      if (use.write || !isCommand) this.pendingLinks.push({ element: id, model: use.model, write: use.write, node: use.node });
    }
  }

  private linkExternals(id: string, facts: Facts) {
    for (const [system, { node }] of facts.externals) {
      const external = this.add({
        id: elementId(null, 'external', system.toLowerCase()),
        kind: 'external',
        system: 'system',
        domain: null,
        name: system,
        label: system,
        evidence: this.ws.evidence(node),
      });
      this.link(id, external.id, 'calls', node);
    }
  }

  /** Path parameters, plus the Zod schema the handler parses the body or query with. */
  private input(path: string, facts: Facts): TypeExpr | undefined {
    const fields: Field[] = [...path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1]!,
      type: 'string',
      optional: false,
      note: 'path',
      refs: [],
    }));
    const refs: string[] = [];
    for (const { value, method, node } of facts.opaque) {
      if (method !== 'parse' && method !== 'safeParse' && method !== 'parseAsync') continue;
      const source = /\b(?:req|request)\.(body|query)\b/.exec(node.arguments[0]?.getText() ?? '')?.[1];
      if (!source) continue;
      const shape = this.types.shape(value);
      if (shape.fields && shape.refs.length !== 1) fields.push(...shape.fields.map((f) => ({ ...f, note: f.note ?? source })));
      else if (shape.text === shape.refs[0]) {
        fields.push({ name: '…', type: shape.text, optional: false, note: source, refs: shape.refs });
        refs.push(...shape.refs);
      } else if (shape.fields) fields.push(...shape.fields);
    }
    if (!fields.length) return undefined;
    return {
      type: `{ ${fields.map((f) => (f.name === '…' ? `…${f.type}` : f.name)).join(', ')} }`,
      refs: [...new Set([...refs, ...fields.flatMap((f) => f.refs)])],
      fields,
    };
  }

  /** `res.json(x)`, `res.status(201).json(x)` and `res.sendStatus(204)`. */
  private responses(facts: Facts): { responses: RouteResponse[]; errors: { statuses: number[]; codes: string[] } } {
    const responses = new Map<number, TypeExpr>();
    const errors = { statuses: [] as number[], codes: [] as string[] };
    for (const { value, method, node, scope } of facts.opaque) {
      if (!['json', 'send', 'end', 'sendStatus'].includes(method)) continue;
      // Only the Express response counts: `res.json(x)` or `res.status(201).json(x)`.
      if (!/^(res|response|reply)$/.test(rootIdentifier(node.expression) ?? '')) continue;
      const chained = value.k === 'call' && value.name === 'status' ? value.args[0]?.() : undefined;
      const argument = node.arguments[0];
      const status =
        method === 'sendStatus'
          ? Number(argument?.getText())
          : chained?.k === 'num'
            ? chained.v
            : 200;
      if (!Number.isInteger(status)) continue;
      if (status >= 400) {
        if (!errors.statuses.includes(status)) errors.statuses.push(status);
        const code = argument && ts.isObjectLiteralExpression(argument) ? errorCode(argument) : undefined;
        if (code && !errors.codes.includes(code)) errors.codes.push(code);
        continue;
      }
      const body: TypeExpr =
        method === 'sendStatus' || !argument
          ? { type: 'void', refs: [] }
          : this.typeOf(this.ev.eval(argument, scope), 0);
      const known = responses.get(status);
      if (!known || known.type === 'unknown') responses.set(status, body);
    }
    errors.statuses.sort((a, b) => a - b);
    return { responses: [...responses].sort(([a], [b]) => a - b).map(([status, body]) => ({ status, body })), errors };
  }

  /** The type of a value sent as a response, as far as Prisma tells. */
  private typeOf(value: Value, depth: number): TypeExpr {
    if (value.k === 'str') return { type: 'string', refs: [] };
    if (value.k === 'num') return { type: 'number', refs: [] };
    if (value.k === 'bool') return { type: 'boolean', refs: [] };
    if (value.k === 'call' && value.recv?.k === 'member') {
      const model = this.byAccessor.get(value.recv.name);
      if (model) {
        const ref = (type: string): TypeExpr => ({ type, refs: [model.name] });
        if (value.name === 'findMany' || value.name === 'createManyAndReturn') return ref(`${model.name}[]`);
        if (value.name === 'findUnique' || value.name === 'findFirst') return ref(`${model.name} | null`);
        if (value.name === 'count') return { type: 'int', refs: [] };
        if (/Many$/.test(value.name)) return { type: '{ count }', refs: [] };
        if (value.name === 'groupBy' || value.name === 'aggregate') return { type: `${model.name} ${value.name}`, refs: [model.name] };
        return ref(model.name);
      }
    }
    if (value.k === 'obj' && depth < 2) {
      const fields: Field[] = [...value.props].map(([name, thunk]) => {
        const inner = this.typeOf(thunk(), depth + 1);
        return { name, type: inner.type, optional: false, refs: inner.refs };
      });
      return { type: `{ ${fields.map((f) => f.name).join(', ')} }`, refs: [...new Set(fields.flatMap((f) => f.refs))], fields };
    }
    if (value.k === 'arr') {
      const first = value.items[0] ? this.typeOf(value.items[0](), depth + 1) : { type: 'unknown', refs: [] };
      return { type: `${first.type}[]`, refs: first.refs };
    }
    return { type: 'unknown', refs: [] };
  }

  // ---------------------------------------------------------------- workers

  /** `cron.schedule('0 3 * * *', fn)` and `setInterval(fn, ms)`. */
  private readJob(node: ts.CallExpression): { node: ts.CallExpression; schedule?: string; trigger: WorkerElement['trigger'] } | undefined {
    const name = callName(node);
    if (name === 'setInterval' && ts.isIdentifier(node.expression)) {
      const every = node.arguments[1]?.getText();
      return { node, trigger: 'loop', ...(every ? { schedule: `every ${every.replace(/_/g, '')} ms` } : {}) };
    }
    if (name !== 'schedule' || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const scope = this.ev.scopeAt(node);
    const receiver = this.ev.eval(node.expression.expression, scope);
    if (receiver.k !== 'ext' || !/cron|schedule/.test(receiver.spec)) return undefined;
    const schedule = this.ev.str(this.ev.eval(node.arguments[0]!, scope));
    return { node, trigger: 'schedule', ...(schedule ? { schedule } : {}) };
  }

  private addWorker(job: { node: ts.CallExpression; schedule?: string; trigger: WorkerElement['trigger'] }) {
    const callback = job.node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a));
    if (!callback) return;
    const value = this.ev.eval(callback, this.ev.scopeAt(job.node));
    if (value.k !== 'fn') return;
    const facts = this.reach.analyze(value);
    const uses = this.prismaUses(facts);
    if (!uses.some((u) => u.write) && ![...facts.externals.values()].some((e) => e.write)) return;
    // The job is named after the function it runs, not after the closure around it.
    const target: FnValue = facts.entries[0]?.fn ?? value;
    const name = fnName(target.node) ?? fnName(value.node) ?? 'job';
    const file = target.node.getSourceFile().fileName;
    const domain = this.domainOf(file) ?? this.domainOf(job.node.getSourceFile().fileName) ?? 'app';
    const description = jsDoc(target.node);
    const id = elementId(domain, 'worker', name);
    this.add<WorkerElement>({
      id,
      kind: 'worker',
      domain,
      name,
      label: humanize(name),
      ...(description ? { description } : {}),
      evidence: this.ws.evidence(target.node),
      trigger: job.trigger,
      ...(job.schedule ? { schedule: job.schedule } : {}),
      appends: [],
    });
    this.linkUses(id, domain, true, uses);
    this.linkExternals(id, facts);
  }

  // ---------------------------------------------------------------- helpers

  private add<T extends Element>(element: T): T {
    if (!this.elements.has(element.id)) this.elements.set(element.id, element);
    return this.elements.get(element.id) as T;
  }

  private link(source: string, target: string, kind: EdgeKind, at: ts.Node) {
    const key = `${source}|${kind}|${target}`;
    if (source !== target && !this.edges.has(key)) this.edges.set(key, { source, target, kind, evidence: this.ws.evidence(at) });
  }
}

function hasFolders(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

function merge(into: Facts, from: Facts) {
  into.opaque.push(...from.opaque);
  into.entries.push(...from.entries);
  for (const [system, call] of from.externals) {
    const existing = into.externals.get(system);
    if (!existing) into.externals.set(system, call);
    else if (call.write) existing.write = true;
  }
}

/** `res` in `res.status(201).json`. */
function rootIdentifier(node: ts.Expression): string | undefined {
  let current = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) current = current.expression;
    else return ts.isIdentifier(current) ? current.text : undefined;
  }
}

/** `listTasks` for a handler passed by name, `tasks.list` for a controller method. */
function referenceName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return `${node.expression.text}.${node.name.text}`;
  return undefined;
}

/** `requireAuth` or `requireRole('admin')`, when the middleware reads like a guard. */
function guardName(node: ts.Node): string | undefined {
  const callee = ts.isCallExpression(node) ? node.expression : node;
  if (!ts.isIdentifier(callee) || !GUARD.test(callee.text)) return undefined;
  return node.getText().replace(/\s+/g, ' ');
}

function errorCode(literal: ts.ObjectLiteralExpression): string | undefined {
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !/^(error|code)$/.test(property.name.getText())) continue;
    if (ts.isStringLiteral(property.initializer)) return property.initializer.text;
  }
  return undefined;
}

/** The JSDoc comment on the statement a node belongs to. */
function jsDoc(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (!ts.isStatement(current) && !ts.isFunctionDeclaration(current)) continue;
    const doc = ts.getJSDocCommentsAndTags(current).find(ts.isJSDoc);
    const text = doc && ts.getTextOfJSDocComment(doc.comment)?.replace(/\s+/g, ' ').trim();
    return text || undefined;
  }
  return undefined;
}
