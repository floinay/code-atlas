import {
  elementId,
  runChecks,
  type AggregateElement,
  type Column,
  type CommandElement,
  type Domain,
  type DomainsConfig,
  type Edge,
  type EdgeKind,
  type Element,
  type EventElement,
  type Evidence,
  type Model,
  type ProjectionElement,
  type QueryElement,
  type RouteErrors,
  type RouteResponse,
  type SubscriptionElement,
  type TableElement,
  type TypeExpr,
  type TableIndex,
  type WorkerElement,
} from '@code-atlas/model';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import {
  Evaluator,
  Reach,
  TypeReader,
  callName,
  capitalize,
  enclosingFunction,
  fnName,
  humanize,
  walk,
  type CallValue,
  type Entry,
  type ExternalRule,
  type Facts,
  type FnNode,
  type FnValue,
  type Value,
  type Workspace,
} from '@code-atlas/extractor-kit';

export type ExtractOptions = {
  /** Folders that hold one domain per sub-folder. Default: `features`. */
  roots?: string[];
  config?: DomainsConfig;
};

export type ExtractStats = { files: number; ms: number; skipped: string[] };

const SYSTEM_NAMES: Record<string, string> = { zitadel: 'ZITADEL', openbao: 'OpenBao', s3: 'S3', grpc: 'gRPC' };
/** For plain HTTP and gRPC clients the system is named after the adapter file: `mailtrap-email.ts` → Mailtrap. */
const systemFromFile = (file: string) => {
  const stem = basename(file)
    .replace(/\.(ts|mts)$/, '')
    .replace(/[-.](client|api|sdk|adapter|provider|gateway|email|transport|storage|webhook\.handler|webhook|handler)$/, '');
  return SYSTEM_NAMES[stem] ?? capitalize(humanize(stem));
};
const EXTERNALS: ExternalRule[] = [
  { match: /platform\/zitadel|@zitadel\//, system: 'ZITADEL' },
  { match: /@aws-sdk\/s3-request-presigner/, system: 'S3', direct: true },
  { match: /@aws-sdk\//, system: 'S3' },
  { match: /@grpc\//, system: systemFromFile },
  { match: /@temporalio\/|platform\/temporal/, system: 'Temporal' },
  { match: /^node:https?$|^undici$|^axios$|^fetch$/, system: systemFromFile, direct: true },
];

const isCall = (value: Value | undefined, name: string): value is CallValue =>
  value?.k === 'call' && value.name === name && !value.recv;
const prop = (value: Value | undefined, name: string): Value | undefined =>
  value?.k === 'obj' ? value.props.get(name)?.() : undefined;

type RouteDef = { value: CallValue; name: string; domain: string };
type EventDef = {
  name: string;
  aggregateType: string;
  domain: string;
  id: string;
  /** Where the event is defined. */
  node: ts.Node;
  /** A `defineEvent` call, when there is one. Generated events have none. */
  value?: CallValue;
  payload?: () => TypeExpr | undefined;
};
type AggregateDef = { type: string; domain: string; id: string; contract?: CallValue; definition?: CallValue };
type TableDef = { value: CallValue; id: string; domain: string; generated: boolean };

/**
 * The versioning platform (`@/platform/aggregate-versioning`) generates a
 * family of events, three projections and their tables for a contract. None of
 * that is written in the feature, so the extractor knows the platform's shape.
 */
const VERSIONING_EVENTS: { prop: string; suffix: string; when?: 'archive' | 'delete' | 'suspend'; payload: 'data' | 'version' | 'none' }[] = [
  { prop: 'created', suffix: 'created', payload: 'data' },
  { prop: 'draftSaved', suffix: 'draft-saved', payload: 'data' },
  { prop: 'draftRestored', suffix: 'draft-restored', payload: 'data' },
  { prop: 'published', suffix: 'published', payload: 'version' },
  { prop: 'unpublished', suffix: 'unpublished', payload: 'none' },
  { prop: 'archived', suffix: 'archived', when: 'archive', payload: 'none' },
  { prop: 'unarchived', suffix: 'unarchived', when: 'archive', payload: 'none' },
  { prop: 'deleted', suffix: 'deleted', when: 'delete', payload: 'none' },
  { prop: 'suspended', suffix: 'suspended', when: 'suspend', payload: 'none' },
  { prop: 'resumed', suffix: 'resumed', when: 'suspend', payload: 'none' },
];
/** Storage method → the generated event it appends. */
const STORAGE_COMMANDS: Record<string, string> = {
  create: 'created', saveDraft: 'draftSaved', restoreDraft: 'draftRestored', publish: 'published',
  unpublish: 'unpublished', archive: 'archived', unarchive: 'unarchived', delete: 'deleted',
  suspend: 'suspended', resume: 'resumed',
};
/** Storage method → the projection it reads. */
const STORAGE_READS: Record<string, Role> = {
  getDraft: 'drafts', getPublished: 'published', getVersion: 'versions', listVersions: 'versions',
};
const ROLES = ['drafts', 'published', 'versions'] as const;
type Role = (typeof ROLES)[number];
type Versioned = { key: string; contract: CallValue; events: Map<string, EventDef> };
type Storage = { projections: Record<Role, string>; versioned: Versioned };
const MIGRATION = /backfill|migrat/i;

/**
 * Reads a Yeda monorepo: features/<name> are domains, the route, event,
 * aggregate, entity and table DSL become elements, and handlers are followed
 * to find what they load, append, read and call.
 */
export class YedaExtraction {
  private ev: Evaluator;
  private types: TypeReader;
  private reach: Reach;
  private roots: string[];
  private versioned = new Map<ts.Node, Versioned | null>();
  private storages = new Map<ts.Node, Storage>();
  private elements = new Map<string, Element>();
  private edges = new Map<string, Edge>();
  private routes = new Map<string, RouteDef>();
  private events = new Map<string, EventDef>();
  private aggregates = new Map<string, AggregateDef>();
  private tables = new Map<string, TableDef>();
  private entities: { value: CallValue; domain: string }[] = [];
  /** By definition site: a feature is one thing however many times it is reached. */
  private features = new Map<string, { value: CallValue; domain: string }>();
  private files: string[] = [];
  /** Files the config adds to a domain: where a service composes what the features define. */
  private composition = new Set<string>();
  /** True while reading a composition file. */
  private composing = false;
  /** HTTP entry points outside the route registry, and the system their file is named after. */
  private webhooks: { id: string; system: string; node: ts.Node }[] = [];
  private seen = new Set<string>();
  private handled = new Set<string>();
  readonly stats: ExtractStats = { files: 0, ms: 0, skipped: [] };

  constructor(
    private ws: Workspace,
    private options: ExtractOptions = {},
  ) {
    this.roots = options.roots ?? options.config?.roots ?? ['features'];
    const inlinable = (file: string) => this.domainOf(file) !== undefined;
    this.ev = new Evaluator(ws, inlinable, new Set(['defineVersioningTables']), () => this.files);
    this.types = new TypeReader(this.ev, (file) => this.domainOf(file) ?? 'platform');
    this.reach = new Reach(this.ev, { isTable: (v) => this.tableKey(v) !== undefined, externals: EXTERNALS });
  }

  /** The domain a file belongs to: its folder under a root, or a path claimed in the config. */
  private domainOf(file: string): string | undefined {
    const rel = this.ws.rel(file);
    for (const [id, override] of Object.entries(this.options.config?.domains ?? {}))
      if (override.paths?.some((path) => rel === path || rel.startsWith(`${path.replace(/\/$/, '')}/`)))
        return override.mergeInto ?? id;
    for (const root of this.roots) {
      if (!rel.startsWith(`${root}/`)) continue;
      const folder = rel.slice(root.length + 1).split('/')[0];
      if (!folder || this.options.config?.domains[folder]?.ignore) return undefined;
      return this.options.config?.domains[folder]?.mergeInto ?? folder;
    }
    return undefined;
  }
  private domainOfNode(node: ts.Node): string {
    return this.domainOf(node.getSourceFile().fileName) ?? 'platform';
  }

  run(): Model {
    const started = performance.now();
    const folders = this.featureFolders();
    const skipClient = (rel: string) => /\/client(\/|$)/.test(rel);
    const extra = Object.values(this.options.config?.domains ?? {}).flatMap((d) => d.paths ?? []);
    const composition = extra.flatMap((path) => (/\.(ts|mts)$/.test(path) ? [this.ws.abs(path)] : this.ws.listSources(path, skipClient)));
    const files = [...folders.flatMap(({ root, folder }) => this.ws.listSources(`${root}/${folder}`, skipClient)), ...composition];
    this.files = files;
    this.composition = new Set(composition);
    this.stats.files = files.length;

    // 1. Definitions: every top-level value, and whatever it holds.
    for (const file of files) {
      const info = this.ws.file(file);
      if (!info) continue;
      this.composing = this.composition.has(file);
      for (const declaration of info.locals.values()) {
        if (declaration.kind === 'class') continue;
        // A function is only worth evaluating when something calls it; its results surface there.
        if (declaration.kind === 'function') continue;
        this.collect(this.ev.declared(declaration), 0);
      }
    }
    // 2. Elements that need nothing but their own definition.
    for (const event of this.events.values()) this.addEvent(event);
    this.addAggregates();
    for (const table of this.tables.values()) if (!table.generated) this.addTable(table);
    this.addProjections();
    for (const file of files) this.addStorages(file);
    // 3. Behaviour: handlers and background work.
    for (const feature of this.features.values()) this.addFeature(feature);
    for (const file of composition) this.addActivities(file);
    this.addUnhandledRoutes();
    // A webhook is called by the system its file is named after, when that system is on the map.
    for (const { id, system, node } of this.webhooks) {
      const caller = elementId(null, 'external', system.toLowerCase());
      if (this.elements.has(caller)) this.link(caller, id, 'calls', node);
    }

    const edges = [...this.edges.values()].filter((e) => this.elements.has(e.source) && this.elements.has(e.target));
    // A generated event that nothing appends and nothing consumes is only a definition.
    const linked = new Set(edges.flatMap((e) => (e.kind === 'emits' ? [] : [e.source, e.target])));
    const appended = new Set([...this.elements.values()].flatMap((e) => (e.kind === 'command' || e.kind === 'worker' ? e.appends : [])));
    for (const event of this.events.values())
      if (!event.value && !linked.has(event.id) && !appended.has(event.id)) this.elements.delete(event.id);
    const elements = [...this.elements.values()];
    const used = new Set(elements.map((e) => e.domain).filter((d): d is string => !!d));
    const domains = folders.map(({ root, folder }) => this.domain(root, folder)).filter((d) => used.has(d.id));
    const { types, rename } = this.types.finalize();
    const draft: Omit<Model, 'types'> = {
      version: 1,
      repo: { name: basename(this.ws.root), adapter: 'yeda' },
      domains: [...new Map(domains.map((d) => [d.id, d])).values()],
      collapsed: [],
      elements,
      edges: edges.filter((e) => this.elements.has(e.source) && this.elements.has(e.target)),
      checks: [],
    };
    const model: Model = { ...(JSON.parse(rename(JSON.stringify(draft))) as typeof draft), types };
    model.checks = runChecks(model);
    this.stats.ms = Math.round(performance.now() - started);
    return model;
  }

  private featureFolders(): { root: string; folder: string }[] {
    return this.roots.flatMap((root) => {
      const dir = this.ws.abs(root);
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .filter((name) => !this.options.config?.domains[name]?.ignore)
        .sort()
        .map((folder) => ({ root, folder }));
    });
  }

  private domain(root: string, folder: string): Domain {
    const override = this.options.config?.domains[folder];
    const id = override?.mergeInto ?? folder;
    const target = this.options.config?.domains[id] ?? override;
    const path = `${root}/${id}`;
    const description = target?.description ?? readmeSummary(join(this.ws.abs(path), 'README.md'));
    return {
      id,
      name: target?.name ?? capitalize(humanize(id)),
      path,
      ...(description ? { description } : {}),
    };
  }

  // ---------------------------------------------------------------- definitions

  private collect(value: Value, depth: number) {
    if (depth > 4) return;
    if (value.k === 'obj') {
      for (const thunk of value.props.values()) this.collect(thunk(), depth + 1);
      return;
    }
    if (value.k === 'arr') {
      for (const thunk of value.items) this.collect(thunk(), depth + 1);
      return;
    }
    if (value.k !== 'call') return;
    const domain = this.domainOfNode(value.node);
    switch (value.name) {
      case 'defineRoute': {
        const name = this.ev.str(prop(value.args[0]?.(), 'name'));
        if (name && !this.routes.has(name)) this.routes.set(name, { value, name, domain });
        break;
      }
      case 'defineEvent':
        this.eventOf(value);
        break;
      case 'defineAggregateContract':
        this.aggregateOf(value);
        break;
      case 'defineAggregate': {
        const contract = prop(value.args[0]?.(), 'contract');
        const aggregate = isCall(contract, 'defineAggregateContract') ? this.aggregateOf(contract) : undefined;
        if (aggregate && !aggregate.definition) aggregate.definition = value;
        break;
      }
      case 'defineEntity':
        if (this.once(value, 'entity')) this.entities.push({ value, domain });
        break;
      case 'defineFeature': {
        // The feature as a service composes it knows its dependencies; the bare definition does not.
        const key = `${value.node.getSourceFile().fileName}:${value.node.pos}`;
        if (!this.features.has(key) || this.composing) this.features.set(key, { value, domain });
        break;
      }
      case 'defineLiveProjection':
        // Its sync route may be written inline.
        this.collect(prop(value.args[0]?.(), 'syncRoute') ?? { k: 'unknown' }, depth + 1);
        break;
      case 'table':
        this.tableKey(value);
        break;
    }
  }

  private once(value: CallValue, kind: string): boolean {
    const key = `${kind}:${value.node.getSourceFile().fileName}:${value.node.pos}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private eventOf(value: Value | undefined): EventDef | undefined {
    // Contract.versioningEvents.created, Aggregate.contract.versioning.versioningEvents.created
    if (value?.k === 'member' && value.of.k === 'member' && value.of.name === 'versioningEvents')
      return this.versionedFrom(value.of.of)?.events.get(value.name);
    if (!isCall(value, 'defineEvent')) return undefined;
    const config = value.args[0]?.();
    const name = this.ev.str(prop(config, 'name'));
    if (!name) return undefined;
    return this.registerEvent(name, this.ev.str(prop(config, 'aggregateType')) ?? '', value.node, {
      value,
      payload: () => this.types.expr(prop(config, 'payload')),
    });
  }

  private registerEvent(name: string, aggregateType: string, node: ts.Node, extra: Pick<EventDef, 'value' | 'payload'>): EventDef {
    const key = `${name}|${aggregateType}`;
    const existing = this.events.get(key);
    if (existing) return existing;
    const domain = this.domainOfNode(node);
    // The same event name on a second stream type is a different fact.
    const clash = [...this.events.values()].some((e) => e.name === name && e.domain === domain);
    const event: EventDef = {
      name,
      aggregateType,
      domain,
      id: elementId(domain, 'event', clash ? `${name}@${aggregateType}` : name),
      node,
      ...extra,
    };
    this.events.set(key, event);
    return event;
  }

  /** The versioning family behind a contract, an aggregate or one of their members. */
  private versionedFrom(value: Value | undefined): Versioned | undefined {
    let current = value;
    while (current?.k === 'member' && (current.name === 'versioning' || current.name === 'contract')) current = current.of;
    if (isCall(current, 'defineAggregate')) current = prop(current.args[0]?.(), 'contract');
    if (!isCall(current, 'defineAggregateContract')) return undefined;
    const cached = this.versioned.get(current.node);
    if (cached !== undefined) return cached ?? undefined;
    const mixin = current.args[1]?.();
    const base = current.args[0]?.();
    const key = isCall(mixin, 'withVersioning') ? this.ev.str(prop(mixin.args[0]?.(), 'key')) : undefined;
    const type = this.ev.str(prop(base, 'type'));
    if (!isCall(mixin, 'withVersioning') || !key || !type) {
      this.versioned.set(current.node, null);
      return undefined;
    }
    const lifecycle = prop(mixin.args[0]?.(), 'lifecycle');
    const enabled = (flag: string) => prop(lifecycle, flag)?.k === 'bool' && (prop(lifecycle, flag) as { v: boolean }).v;
    const data = () => this.types.expr(prop(base, 'schema'));
    const events = new Map<string, EventDef>();
    for (const spec of VERSIONING_EVENTS) {
      if (spec.when && !enabled(spec.when)) continue;
      const payload = (): TypeExpr | undefined => {
        if (spec.payload === 'none') return { type: '{}', refs: [], fields: [] };
        if (spec.payload === 'version')
          return { type: '{ versionId }', refs: [], fields: [{ name: 'versionId', type: 'string', optional: false, refs: [] }] };
        const schema = data();
        return schema
          ? {
              type: '{ data, dataSchemaVersion }',
              refs: schema.refs,
              fields: [
                { name: 'data', type: schema.type, optional: false, refs: schema.refs },
                { name: 'dataSchemaVersion', type: 'int', optional: false, refs: [] },
              ],
            }
          : undefined;
      };
      events.set(spec.prop, this.registerEvent(`${key}.${spec.suffix}`, type, mixin.node, { payload }));
    }
    const versioned: Versioned = { key, contract: current, events };
    this.versioned.set(current.node, versioned);
    return versioned;
  }

  private aggregateOf(contract: CallValue): AggregateDef | undefined {
    const config = contract.args[0]?.();
    const type = this.ev.str(prop(config, 'type'));
    if (!type) return undefined;
    const domain = this.domainOfNode(contract.node);
    const key = `${domain}|${type}`;
    let aggregate = this.aggregates.get(key);
    if (!aggregate) {
      aggregate = { type, domain, id: '', contract };
      this.aggregates.set(key, aggregate);
      this.versionedFrom(contract);
    }
    return aggregate;
  }

  /** `schema.table('name', …)`: identified by schema and table name. */
  private tableKey(value: Value | undefined): string | undefined {
    if (value?.k !== 'call' || value.name !== 'table' || value.recv?.k !== 'call' || value.recv.name !== 'pgSchema')
      return undefined;
    const schema = this.ev.str(value.recv.args[0]?.());
    const name = this.ev.str(value.args[0]?.());
    if (!schema || !name) return undefined;
    const key = `${schema}.${name}`;
    if (!this.tables.has(key)) {
      // A table built by a platform helper still belongs to the feature that owns the schema.
      const generated = this.domainOf(value.node.getSourceFile().fileName) === undefined;
      const domain = this.domainOfNode(generated ? value.recv.node : value.node);
      this.tables.set(key, { value, domain, id: elementId(domain, 'table', key), generated });
    }
    return key;
  }

  // ---------------------------------------------------------------- elements

  private add<T extends Element>(element: T): T {
    if (!this.elements.has(element.id)) this.elements.set(element.id, element);
    return this.elements.get(element.id) as T;
  }

  private link(source: string, target: string, kind: EdgeKind, at: ts.Node | Evidence) {
    if (source === target) return;
    const key = `${source}|${kind}|${target}`;
    if (this.edges.has(key)) return;
    const evidence = 'file' in at ? at : this.ws.evidence(at);
    this.edges.set(key, { source, target, kind, evidence });
  }

  private label(name: string, domain: string): string {
    return name.startsWith(`${domain}.`) ? name.slice(domain.length + 1) : name;
  }

  private addEvent(event: EventDef) {
    const config = event.value?.args[0]?.();
    const payload = event.payload?.();
    const version = prop(config, 'schemaVersion');
    const short = this.label(event.name, event.domain);
    this.add<EventElement>({
      id: event.id,
      kind: 'event',
      domain: event.domain,
      name: event.name,
      label: event.id.includes('@') ? `${short} (${event.aggregateType})` : short,
      ...(event.value ? this.describe(event.value) : {}),
      evidence: this.ws.evidence(event.node),
      ...(payload ? { payload } : {}),
      ...(version?.k === 'num' ? { schemaVersion: version.v } : event.value ? {} : { schemaVersion: 1 }),
    });
  }

  private addAggregates() {
    // Events that name a stream type nobody defines still live in a stream.
    for (const event of this.events.values()) {
      if (!event.aggregateType) continue;
      const key = `${event.domain}|${event.aggregateType}`;
      if (!this.aggregates.has(key)) this.aggregates.set(key, { type: event.aggregateType, domain: event.domain, id: '' });
    }
    for (const aggregate of this.aggregates.values()) {
      const origin = aggregate.definition?.origin ?? aggregate.contract?.origin;
      const label = origin
        ? capitalize(origin.name.replace(/(Aggregate)?Contract$/, '').replace(/Aggregate$/, '')) || aggregate.type
        : aggregate.type;
      aggregate.id = elementId(aggregate.domain, 'aggregate', label);
      const config = aggregate.contract?.args[0]?.();
      const state = this.types.expr(prop(config, 'schema'));
      const definition = aggregate.definition?.args[0]?.();
      const anchor = aggregate.definition ?? aggregate.contract;
      const firstEvent = [...this.events.values()].find((e) => e.domain === aggregate.domain && e.aggregateType === aggregate.type);
      this.add<AggregateElement>({
        id: aggregate.id,
        kind: 'aggregate',
        domain: aggregate.domain,
        name: label,
        label,
        ...(anchor ? this.describe(anchor) : {}),
        evidence: this.ws.evidence(anchor ? anchor.node : firstEvent!.node),
        ...(state ? { state } : {}),
        storage: { kind: 'event-store', stream: aggregate.type, snapshot: !!prop(definition, 'snapshot') },
      });
      const generated = aggregate.contract ? [...(this.versionedFrom(aggregate.contract)?.events.values() ?? [])] : [];
      const listed = [...this.eventsIn(prop(config, 'events')), ...generated];
      const emitted = listed.length
        ? listed
        : [...this.events.values()].filter((e) => e.domain === aggregate.domain && e.aggregateType === aggregate.type);
      for (const event of emitted) this.link(aggregate.id, event.id, 'emits', aggregate.contract?.node ?? event.node);
    }
  }

  private aggregateOfEvent(event: EventDef): AggregateDef | undefined {
    return this.aggregates.get(`${event.domain}|${event.aggregateType}`);
  }

  /** Every event a value stands for: arrays, spreads, `on(…)`, `combine(…)` and entity handlers. */
  private eventsIn(value: Value | undefined, depth = 0): EventDef[] {
    if (!value || depth > 8) return [];
    if (value.k === 'arr') return value.items.flatMap((item) => this.eventsIn(item(), depth + 1));
    if (value.k === 'call') {
      if (value.name === 'defineEvent') {
        const event = this.eventOf(value);
        return event ? [event] : [];
      }
      if (value.name === 'on') return this.eventsIn(value.args[0]?.(), depth + 1);
      if (value.name === 'combine') return value.args.flatMap((arg) => this.eventsIn(arg(), depth + 1));
      return [];
    }
    if (value.k === 'member' && value.name === 'events') {
      const owner = value.of;
      if (owner.k === 'call' && (owner.name === 'on' || owner.name === 'combine')) return this.eventsIn(owner, depth + 1);
      // someEntity.projectionHandler.events
      const entity = owner.k === 'member' && owner.name === 'projectionHandler' ? owner.of : owner;
      if (isCall(entity, 'defineEntity')) return this.eventsIn(prop(this.projectionMixin(entity)?.args[1]?.(), 'events'), depth + 1);
    }
    if (value.k === 'obj') return this.eventsIn(prop(value, 'events'), depth + 1);
    return [];
  }

  private addTable(table: TableDef) {
    const { value } = table;
    const schema = this.ev.str((value.recv as CallValue).args[0]?.())!;
    const name = this.ev.str(value.args[0]?.())!;
    const columns: Column[] = [];
    const sqlNames = new Map<string, string>();
    const shape = value.args[1]?.();
    if (shape?.k === 'obj')
      for (const [key, thunk] of shape.props) {
        const methods: string[] = [];
        let current = thunk();
        let typeNote: string | undefined;
        while (current.k === 'call' && current.recv?.k === 'call') {
          methods.push(current.name);
          if (current.name === '$type' && ts.isCallExpression(current.node))
            typeNote = current.node.typeArguments?.[0]?.getText().replace(/\s+/g, ' ');
          current = current.recv;
        }
        if (current.k !== 'call') continue;
        const sqlName = this.ev.str(current.args[0]?.()) ?? key;
        sqlNames.set(key, sqlName);
        columns.push({
          name: sqlName,
          type: current.name,
          primaryKey: methods.includes('primaryKey'),
          notNull: methods.includes('notNull') || methods.includes('primaryKey'),
          ...(typeNote && typeNote.length <= 40 ? { note: typeNote } : {}),
        });
      }
    const indexes: TableIndex[] = [];
    let primaryKey = columns.filter((c) => c.primaryKey).map((c) => c.name);
    const constraints = value.args[2]?.();
    const built = constraints?.k === 'fn' ? this.ev.apply(constraints, [{ k: 'unknown' }]) : constraints;
    const columnNames = (list: Value | undefined) =>
      list?.k === 'arr'
        ? list.items.map((i) => i()).flatMap((v) => (v.k === 'member' ? [sqlNames.get(v.name) ?? v.name] : []))
        : [];
    for (const item of built?.k === 'arr' ? built.items.map((i) => i()) : built?.k === 'obj' ? [...built.props.values()].map((t) => t()) : []) {
      let current = item;
      while (current.k === 'call' && current.name !== 'on' && current.name !== 'primaryKey' && current.recv) current = current.recv;
      if (current.k !== 'call') continue;
      if (current.name === 'primaryKey') primaryKey = columnNames(prop(current.args[0]?.(), 'columns'));
      if (current.name === 'on' && current.recv?.k === 'call' && /index/i.test(current.recv.name))
        indexes.push({
          name: this.ev.str(current.recv.args[0]?.()) ?? 'index',
          columns: current.args.map((a) => a()).flatMap((v) => (v.k === 'member' ? [sqlNames.get(v.name) ?? v.name] : [])),
          unique: current.recv.name === 'uniqueIndex',
        });
    }
    for (const column of columns) if (primaryKey.includes(column.name)) Object.assign(column, { primaryKey: true, notNull: true });
    this.add<TableElement>({
      id: table.id,
      kind: 'table',
      domain: table.domain,
      name: `${schema}.${name}`,
      label: name,
      ...(table.generated ? {} : this.describe(value)),
      evidence: this.ws.evidence(table.generated ? (value.origin?.node ?? (value.recv as CallValue).node) : value.node),
      schema,
      columns,
      primaryKey,
      indexes,
    });
  }

  private projectionMixin(entity: CallValue): CallValue | undefined {
    return entity.args.map((a) => a()).find((m): m is CallValue => isCall(m, 'withProjection'));
  }

  private addProjections() {
    // The contracts package repeats each entity without its handler; keep the one that handles events.
    const byName = new Map<string, { value: CallValue; domain: string }>();
    for (const entity of this.entities) {
      const name = this.ev.str(entity.value.args[0]?.());
      if (!name) continue;
      const key = `${entity.domain}|${name}`;
      const current = byName.get(key);
      const hasHandler = !!this.projectionMixin(entity.value)?.args[1];
      if (!current || (hasHandler && !this.projectionMixin(current.value)?.args[1])) byName.set(key, entity);
    }
    for (const { value: entity, domain } of byName.values()) {
      const mixins = entity.args.slice(1).map((a) => a());
      const projection = this.projectionMixin(entity);
      const live = projection?.args[0]?.();
      const liveConfig = isCall(live, 'defineLiveProjection') || isCall(live, 'defineProjection') ? live.args[0]?.() : undefined;
      const entityName = this.ev.str(entity.args[0]?.())!;
      const key = this.ev.str(prop(liveConfig, 'key')) ?? `${domain}.${entityName}`;
      const handler = projection?.args[1]?.();
      const row = this.types.expr(mixins.find((m): m is CallValue => isCall(m, 'withSchema'))?.args[0]?.());
      const permissions = mixins
        .filter((m): m is CallValue => isCall(m, 'withEntityPermissions') || isCall(m, 'withPermissions'))
        .flatMap((m) => m.args.map((a) => a()))
        .map((p) => this.ev.str(p) ?? this.permissionKey(p))
        .filter((p): p is string => !!p);
      const definition = prop(prop(liveConfig, 'collection'), 'definition');
      const search = prop(isCall(definition, 'defineProjection') ? definition.args[0]?.() : liveConfig, 'search');
      const consumer = this.ev.str(prop(handler, 'consumerName'));
      const description = this.ev.str(prop(liveConfig, 'description'));
      const id = elementId(domain, 'projection', key);
      this.add<ProjectionElement>({
        id,
        kind: 'projection',
        domain,
        name: key,
        label: capitalize(humanize(key.split('.').at(-1) ?? key)),
        ...(description ? { description } : this.describe(entity)),
        evidence: this.ws.evidence(entity.node),
        entity: {
          name: entityName,
          permissions,
          ...(row ? { row } : {}),
          ...(consumer ? { consumer } : {}),
          ...(search?.k === 'arr'
            ? { search: search.items.map((i) => this.ev.str(i())).filter((s): s is string => !!s) }
            : {}),
        },
      });

      const eventsNode = handler?.k === 'obj' ? handler.node : entity.node;
      for (const event of this.eventsIn(prop(handler, 'events'))) this.link(event.id, id, 'handles', eventsNode);

      const handle = prop(handler, 'handle');
      if (handle?.k === 'fn') {
        const facts = this.reach.analyze(handle);
        for (const [table, node] of facts.tableWrites) this.link(id, this.tables.get(this.tableKey(table)!)!.id, 'writes', node);
        this.linkCalls(id, domain, facts);
      }

      const sync = prop(liveConfig, 'syncRoute');
      if (isCall(sync, 'defineSyncRoute')) {
        const config = sync.args[0]?.();
        const name = this.ev.str(prop(config, 'name')) ?? `sync.${key}`;
        const path = this.ev.str(prop(config, 'path'));
        const permission = this.permissionKey(prop(liveConfig, 'permission'));
        const subscription = this.add<SubscriptionElement>({
          id: elementId(domain, 'subscription', name),
          kind: 'subscription',
          domain,
          name,
          label: name,
          ...(description ? { description } : {}),
          evidence: this.ws.evidence(sync.node),
          ...(row ? { row } : {}),
          ...(path ? { path } : {}),
          ...(permission ? { permission } : {}),
        });
        this.link(id, subscription.id, 'streams', (live as CallValue).node);
      }
    }
  }

  /** `createVersioningStorage(Aggregate, { projections, tables })`: three projections per storage. */
  private addStorages(file: string) {
    const source = this.ws.file(file)?.source;
    if (!source || !source.text.includes('createVersioningStorage')) return;
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || callName(node) !== 'createVersioningStorage') return;
      const value = this.ev.eval(node, this.ev.scopeAt(node));
      if (value.k === 'call') this.storageOf(value);
    });
  }

  private storageOf(value: Value | undefined): Storage | undefined {
    if (!isCall(value, 'createVersioningStorage')) return undefined;
    const known = this.storages.get(value.node);
    if (known) return known;
    const versioned = this.versionedFrom(value.args[0]?.());
    const options = value.args[1]?.();
    const definition = prop(options, 'projections');
    if (!versioned || !isCall(definition, 'defineVersioningProjections')) return undefined;
    const config = definition.args[1]?.();
    const baseKey = this.ev.str(prop(config, 'key')) ?? versioned.key;
    const domain = this.domainOfNode(value.node);
    const base = this.types.expr(prop(versioned.contract.args[0]?.(), 'schema'));
    const aggregateEvents = [
      ...this.eventsIn(prop(versioned.contract.args[0]?.(), 'events')),
      ...versioned.events.values(),
    ];
    const tables = prop(options, 'tables');
    const storage: Storage = { versioned, projections: { drafts: '', published: '', versions: '' } };
    for (const role of ROLES) {
      const roleKey = this.ev.str(prop(prop(config, 'roleKeys'), role));
      const key = roleKey ?? `${baseKey}.${role}`;
      const id = elementId(domain, 'projection', key);
      storage.projections[role] = id;
      const row: TypeExpr | undefined = base && {
        type: `${capitalize(role.replace(/s$/, ''))}Row<${base.type}>`,
        refs: base.refs,
      };
      const permission = this.permissionKey(prop(prop(config, 'permissions'), role));
      this.add<ProjectionElement>({
        id,
        kind: 'projection',
        domain,
        name: key,
        label: capitalize(humanize(key.split('.').at(-1) ?? key)),
        evidence: this.ws.evidence(value.node),
        entity: {
          name: `${versioned.key}_${role}`,
          permissions: [],
          ...(row ? { row } : {}),
          consumer: `${versioned.key}-${role}`,
        },
      });
      for (const event of aggregateEvents) this.link(event.id, id, 'handles', value.node);
      const table = tables ? this.ev.member(tables, role) : undefined;
      const tableKey = this.tableKey(table);
      if (tableKey) {
        const def = this.tables.get(tableKey)!;
        if (!this.elements.has(def.id)) this.addTable(def);
        this.link(id, def.id, 'writes', value.node);
      }
      // The projection is also a live collection clients subscribe to.
      const tail = roleKey ? (roleKey.startsWith(`${baseKey}.`) ? roleKey.slice(baseKey.length + 1) : roleKey) : role;
      const subscription = this.add<SubscriptionElement>({
        id: elementId(domain, 'subscription', `live.${key}`),
        kind: 'subscription',
        domain,
        name: `live.${key}`,
        label: `live.${key}`,
        evidence: this.ws.evidence(definition.node),
        ...(row ? { row } : {}),
        path: `/api/${baseKey}/collections/${tail}`,
        ...(permission ? { permission } : {}),
      });
      this.link(id, subscription.id, 'streams', definition.node);
    }
    this.storages.set(value.node, storage);
    return storage;
  }

  /** What calls on versioning storages do: the events they append and the projections they read. */
  private storageEffects(facts: Facts): { appends: [EventDef, ts.Node][]; reads: [string, ts.Node][] } {
    const appends: [EventDef, ts.Node][] = [];
    const reads: [string, ts.Node][] = [];
    for (const { value, method, node } of facts.opaque) {
      const storage = this.storageOf(value);
      if (!storage) continue;
      const event = STORAGE_COMMANDS[method] && storage.versioned.events.get(STORAGE_COMMANDS[method]);
      if (event) appends.push([event, node]);
      const role = STORAGE_READS[method];
      if (role) reads.push([storage.projections[role], node]);
    }
    return { appends, reads };
  }

  /** `listenEvents(...handlers, { projection })`: a projection without an entity. */
  private addListener(listener: CallValue, domain: string) {
    const values = listener.args.map((a) => a());
    const config = values.at(-1);
    const definition = prop(config, 'projection');
    const key =
      (isCall(definition, 'defineProjection') ? this.ev.str(prop(definition.args[0]?.(), 'key')) : undefined) ??
      this.ev.str(prop(config, 'consumerName'));
    if (!key) return;
    const id = elementId(domain, 'projection', key);
    const row = isCall(definition, 'defineProjection') ? this.types.expr(prop(definition.args[0]?.(), 'row')) : undefined;
    const consumer = this.ev.str(prop(config, 'consumerName'));
    this.add<ProjectionElement>({
      id,
      kind: 'projection',
      domain,
      name: key,
      label: capitalize(humanize(key.split('.').at(-1) ?? key)),
      ...(isCall(definition, 'defineProjection') ? this.describe(definition) : {}),
      evidence: this.ws.evidence(listener.node),
      entity: { name: key, permissions: [], ...(row ? { row } : {}), ...(consumer ? { consumer } : {}) },
    });
    const handlers = values.slice(0, -1);
    for (const event of this.eventsIn({ k: 'arr', items: handlers.map((h) => () => h), node: listener.node }))
      this.link(event.id, id, 'handles', listener.node);
    const facts = this.reach.analyzeHeld(handlers, listener.node);
    for (const [table, node] of facts.tableWrites) this.link(id, this.tables.get(this.tableKey(table)!)!.id, 'writes', node);
    this.linkCalls(id, domain, facts);
  }

  private permissionKey(value: Value | undefined): string | undefined {
    return isCall(value, 'definePermission') ? this.ev.str(value.args[0]?.()) : undefined;
  }

  /** The description next to a definition: its JSDoc comment. */
  private describe(value: CallValue): { description?: string } {
    return this.describeNode(value.origin?.node ?? value.node);
  }

  private describeNode(declaration: ts.Node): { description?: string } {
    for (let node: ts.Node | undefined = declaration; node && !ts.isSourceFile(node); node = node.parent) {
      if (!ts.isVariableStatement(node) && !ts.isFunctionDeclaration(node) && !ts.isPropertyAssignment(node)) continue;
      const doc = ts.getJSDocCommentsAndTags(node).find(ts.isJSDoc);
      const text = doc && ts.getTextOfJSDocComment(doc.comment)?.replace(/\s+/g, ' ').trim();
      if (text) return { description: text };
      if (ts.isVariableStatement(node)) break;
    }
    return {};
  }

  // ---------------------------------------------------------------- behaviour

  private addFeature(feature: { value: CallValue; domain: string }) {
    const { value, domain } = feature;
    const parts: Value[] = [];
    const first = value.args[0]?.();
    if (first?.k === 'obj') {
      const routes = prop(first, 'routes');
      if (routes) parts.push({ k: 'call', name: 'withRoutes', args: [() => routes], node: value.node, scope: value.scope });
      const start = prop(first, 'start');
      if (start) parts.push({ k: 'call', name: 'withStart', args: [() => start], node: value.node, scope: value.scope });
    }
    const body = value.args[1]?.();
    const built = body?.k === 'fn' ? this.ev.apply(body, []) : body;
    if (built?.k === 'arr') parts.push(...built.items.map((i) => i()));

    for (const part of parts) {
      if (part.k !== 'call') continue;
      if (part.name === 'withRoutes') for (const route of this.flatten(part.args[0]?.())) this.addHandler(route, domain);
      if (part.name === 'withStart') {
        const start = part.args[0]?.();
        if (start?.k === 'fn') {
          this.addWorkers(start, domain);
          this.addWebhook(start, domain);
        }
      }
    }
  }

  private flatten(value: Value | undefined): Value[] {
    if (!value) return [];
    if (value.k === 'arr') return value.items.flatMap((i) => this.flatten(i()));
    return [value];
  }

  private routeElement(route: RouteDef, kind: 'command' | 'query', facts?: Facts): CommandElement | QueryElement {
    const [config, ...mixins] = route.value.args.map((a) => a());
    const http = this.findMixin(mixins, 'withHttp');
    const httpConfig = http?.args[0]?.();
    const method = this.ev.str(prop(httpConfig, 'method'));
    const path = this.ev.str(prop(httpConfig, 'path'));
    const mcp = this.findMixin(mixins, 'withMcp')?.args[0]?.();
    const declared = this.permissionKey(this.findMixin(mixins, 'withPermission')?.args[0]?.());
    const checked = facts ? [...facts.permissions.keys()].map((p) => this.permissionKey(p)).find(Boolean) : undefined;
    const permission = declared ?? checked;
    const input = this.types.expr(prop(config, 'input'));
    const { responses, errors } = this.responses(prop(config, 'responses'));
    const description =
      this.describe(route.value).description ?? this.ev.str(prop(mcp, 'description')) ?? this.ev.str(prop(config, 'description'));
    return {
      id: elementId(route.domain, kind, route.name),
      kind,
      domain: route.domain,
      name: route.name,
      label: this.label(route.name, route.domain),
      ...(description ? { description } : {}),
      evidence: this.ws.evidence(route.value.node),
      ...(method && path ? { http: { method, path } } : {}),
      ...(permission ? { permission } : {}),
      ...(input ? { input } : {}),
      responses,
      ...(errors ? { errors } : {}),
      ...(kind === 'command' ? { appends: [] } : {}),
    } as CommandElement | QueryElement;
  }

  private findMixin(mixins: Value[], name: string): CallValue | undefined {
    for (const mixin of mixins) {
      if (mixin.k !== 'call') continue;
      if (mixin.name === name && !mixin.recv) return mixin;
      // withHttp({...}, withOpenApi(...)) nests further mixins as arguments.
      const nested = this.findMixin(mixin.args.slice(1).map((a) => a()), name);
      if (nested) return nested;
    }
    return undefined;
  }

  private responses(value: Value | undefined): { responses: RouteResponse[]; errors?: RouteErrors } {
    const responses: RouteResponse[] = [];
    const statuses: number[] = [];
    const codes: string[] = [];
    for (const item of this.flatten(value)) {
      if (!isCall(item, 'response')) continue;
      const status = item.args[0]?.();
      if (status?.k !== 'num') continue;
      const schema = item.args[1]?.();
      if (status.v < 400) {
        const body = this.types.expr(schema);
        if (body) responses.push({ status: status.v, body });
        continue;
      }
      if (!statuses.includes(status.v)) statuses.push(status.v);
      if (schema) for (const code of this.types.shape(schema).props?.get('code')?.values ?? []) if (!codes.includes(code)) codes.push(code);
    }
    return { responses, ...(statuses.length ? { errors: { statuses, codes } } : {}) };
  }

  private routeOf(value: Value | undefined): RouteDef | undefined {
    if (!isCall(value, 'defineRoute')) return undefined;
    const name = this.ev.str(prop(value.args[0]?.(), 'name'));
    if (!name) return undefined;
    let route = this.routes.get(name);
    if (!route) {
      route = { value, name, domain: this.domainOfNode(value.node) };
      this.routes.set(name, route);
    }
    return route;
  }

  /** Whether the facts show a state change. Reads and loads alone make a query. */
  private changesState(facts: Facts): boolean {
    return (
      facts.drafts.size > 0 ||
      facts.tableWrites.size > 0 ||
      [...facts.externals.values()].some((e) => e.write) ||
      this.storageEffects(facts).appends.length > 0
    );
  }

  private pendingCalls: { source: string; route: RouteDef; node: ts.Node }[] = [];
  private routeFacts = new Map<string, { route: RouteDef; facts: Facts; node: ts.Node }>();

  private addHandler(registration: Value, _domain: string) {
    if (!isCall(registration, 'localRoute')) return;
    const route = this.routeOf(registration.args[0]?.());
    const handler = registration.args[1]?.();
    if (!route || this.routeFacts.has(route.name)) return;
    const facts = handler?.k === 'fn' ? this.reach.analyze(handler) : undefined;
    if (!facts) return;
    this.routeFacts.set(route.name, { route, facts, node: registration.node });
  }

  /** Called once every handler is analysed: a route that calls a command is a command too. */
  private finishRoutes() {
    const commands = new Set<string>();
    for (const [name, { facts }] of this.routeFacts) if (this.changesState(facts)) commands.add(name);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, { facts }] of this.routeFacts) {
        if (commands.has(name)) continue;
        const callsCommand = [...facts.invokes.keys()].some((r) => commands.has(this.routeOf(r)?.name ?? ''));
        if (callsCommand) {
          commands.add(name);
          changed = true;
        }
      }
    }
    for (const [name, { route, facts }] of this.routeFacts) {
      const kind = commands.has(name) ? 'command' : 'query';
      const element = this.add(this.routeElement(route, kind, facts));
      this.handled.add(name);
      this.routeIds.set(name, element.id);
      if (element.kind === 'command') this.linkWrites(element, facts);
      else this.linkReads(element.id, facts);
      this.linkCalls(element.id, route.domain, facts);
    }
    for (const call of this.pendingCalls) {
      const target = this.routeIds.get(call.route.name);
      if (target) this.link(call.source, target, 'calls', call.node);
    }
  }
  private routeIds = new Map<string, string>();

  private linkWrites(element: CommandElement | WorkerElement, facts: Facts) {
    const appends = new Set<string>();
    const drafted: [EventDef | undefined, ts.Node][] = [...facts.drafts].map(([value, node]) => [this.eventOf(value), node]);
    for (const [event, node] of [...drafted, ...this.storageEffects(facts).appends]) {
      if (!event || !this.elements.has(event.id)) continue;
      appends.add(event.id);
      const aggregate = this.aggregateOfEvent(event);
      if (aggregate) this.link(element.id, aggregate.id, 'decides', node);
    }
    element.appends = [...appends];
    // Without an event store the table is the state: command → table.
    for (const [table, node] of facts.tableWrites) {
      const def = this.tables.get(this.tableKey(table)!)!;
      if (!this.elements.has(def.id)) this.addTable(def);
      this.link(element.id, def.id, 'writes', node);
    }
  }

  private linkReads(id: string, facts: Facts) {
    for (const [value, node] of facts.loads) {
      const contract = isCall(value, 'defineAggregate') ? prop(value.args[0]?.(), 'contract') : value;
      const aggregate = isCall(contract, 'defineAggregateContract') ? this.aggregateOf(contract) : undefined;
      if (aggregate) this.link(aggregate.id, id, 'reads', node);
    }
    for (const [table, node] of facts.tableReads) {
      const def = this.tables.get(this.tableKey(table)!)!;
      if (!this.elements.has(def.id)) this.addTable(def);
      this.link(def.id, id, 'reads', node);
    }
    for (const [projection, node] of this.storageEffects(facts).reads) this.link(projection, id, 'reads', node);
  }

  private linkCalls(id: string, domain: string, facts: Facts) {
    for (const [value, node] of facts.invokes) {
      const route = this.routeOf(value);
      if (route && route.domain !== domain) this.pendingCalls.push({ source: id, route, node });
    }
    for (const [system, { node }] of facts.externals) this.link(id, this.external(system, node).id, 'calls', node);
  }

  private external(system: string, node: ts.Node) {
    return this.add({
      id: elementId(null, 'external', system.toLowerCase()),
      kind: 'external',
      system: 'system',
      domain: null,
      name: system,
      label: system,
      evidence: this.ws.evidence(node),
    });
  }

  // ---------------------------------------------------------------- workers

  /**
   * Background work is whatever the start hook calls that changes state:
   * functions called in its service loop, tasks run once at startup, and
   * migrations, which are kept apart from the function that triggers them.
   */
  private addWorkers(start: FnValue, domain: string) {
    const discovery = this.reach.analyze(start);
    for (const listener of discovery.listeners) this.addListener(listener, domain);
    const isMigration = (fn: FnNode) => MIGRATION.test(fnName(fn) ?? '');
    const queue: Entry[] = [...discovery.entries];
    const done = new Set<FnNode>();
    while (queue.length) {
      const entry = queue.shift()!;
      const node = entry.fn.node;
      if (done.has(node)) continue;
      done.add(node);
      const name = workerName(node);
      if (!name) continue;
      const facts = this.reach.analyze(entry.fn, entry.args, (other) => other !== node && isMigration(other));
      queue.push(...facts.stopped);
      if (!this.changesState(facts)) continue;
      const worker = this.add<WorkerElement>({
        id: elementId(domain, 'worker', name),
        kind: 'worker',
        domain,
        name,
        label: humanize(name),
        ...this.describeNode(node),
        evidence: this.ws.evidence(node),
        trigger: isMigration(node) ? 'migration' : entry.loop || facts.loops ? 'loop' : 'startup',
        appends: [],
      });
      this.linkWrites(worker, facts);
      this.linkCalls(worker.id, domain, facts);
    }
  }

  /**
   * `startTemporalWorker({ activities })` in a composition file: every activity
   * a feature provides is a step that Temporal runs.
   */
  private addActivities(file: string) {
    const source = this.ws.file(file)?.source;
    if (!source || !source.text.includes('startTemporalWorker')) return;
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || callName(node) !== 'startTemporalWorker' || !node.arguments[0]) return;
      const activities = prop(this.ev.eval(node.arguments[0], this.ev.scopeAt(node)), 'activities');
      if (activities?.k !== 'obj') return;
      for (const [name, thunk] of activities.props) {
        const fn = thunk();
        if (fn.k !== 'fn' || !this.ev.canInline(fn)) continue;
        const domain = this.domainOfNode(fn.node);
        const facts = this.reach.analyze(fn);
        const worker = this.add<WorkerElement>({
          id: elementId(domain, 'worker', name),
          kind: 'worker',
          domain,
          name,
          label: humanize(name),
          ...this.describeNode(fn.node),
          evidence: this.ws.evidence(fn.node),
          trigger: 'workflow',
          appends: [],
        });
        this.linkWrites(worker, facts);
        this.linkCalls(worker.id, domain, facts);
        this.link(this.external('Temporal', node).id, worker.id, 'calls', node);
      }
    });
  }

  /**
   * The middleware a start hook returns is an HTTP entry point outside the
   * route registry. One that answers a fixed path and changes state is a
   * command: in practice, a provider's webhook.
   */
  private addWebhook(start: FnValue, domain: string) {
    const middleware = prop(this.ev.apply(start, []), 'middleware');
    if (middleware?.k !== 'fn' || !this.ev.canInline(middleware)) return;
    const scope = this.ev.bind(middleware, []);
    let path: string | undefined;
    let method: string | undefined;
    walk(middleware.node, (node) => {
      if (!ts.isBinaryExpression(node)) return;
      for (const [side, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        if (!ts.isPropertyAccessExpression(side)) continue;
        const value = this.ev.str(this.ev.eval(other, scope));
        if (side.name.text === 'path' && value?.startsWith('/')) path ??= value;
        if (side.name.text === 'method' && value && /^[A-Z]+$/.test(value)) method ??= value;
      }
    });
    const facts = this.reach.analyze(middleware);
    if (!path || !this.changesState(facts)) return;
    const factory = enclosingFunction(middleware.node);
    const stem = humanize((factory && fnName(factory)) ?? fnName(middleware.node) ?? 'webhook').replace(/ /g, '-');
    const name = `${domain}.${stem}`;
    const command = this.add<CommandElement>({
      id: elementId(domain, 'command', name),
      kind: 'command',
      domain,
      name,
      label: stem,
      ...this.describeNode(factory ?? middleware.node),
      evidence: this.ws.evidence(factory ?? middleware.node),
      http: { method: method ?? 'POST', path },
      responses: [],
      appends: [],
    });
    this.linkWrites(command, facts);
    this.linkCalls(command.id, domain, facts);
    this.webhooks.push({ id: command.id, system: systemFromFile(middleware.node.getSourceFile().fileName), node: middleware.node });
  }

  private addUnhandledRoutes() {
    this.finishRoutes();
    for (const route of this.routes.values())
      if (!this.handled.has(route.name)) this.stats.skipped.push(route.name);
  }
}

/** `adoptOrganizations`, or `identitySync.step` for a method of what `createIdentitySync` returns. */
function workerName(fn: FnNode): string | undefined {
  const own = fnName(fn);
  if (!own) return undefined;
  const outer = enclosingFunction(fn);
  const owner = outer && fnName(outer);
  if (!owner) return own;
  const stem = owner.replace(/^(create|make|build|start)(?=[A-Z])/, '');
  return `${stem[0]!.toLowerCase()}${stem.slice(1)}.${own}`;
}

/** The first paragraph of a README, as a one-line description. */
function readmeSummary(file: string): string | undefined {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const paragraph: string[] = [];
    for (const line of lines) {
      const text = line.trim();
      if (!text) {
        if (paragraph.length) break;
        continue;
      }
      if (text.startsWith('#') || text.startsWith('<') || text.startsWith('![') || text.startsWith('|')) continue;
      paragraph.push(text);
    }
    const summary = paragraph.join(' ').replace(/[`*_]/g, '');
    if (!summary) return undefined;
    const sentence = /^.*?[.!?](?=\s|$)/.exec(summary)?.[0] ?? summary;
    return sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence;
  } catch {
    return undefined;
  }
}
