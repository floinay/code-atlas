import * as z from 'zod';

/** Where in the repository a fact was read. No evidence, nothing on the map. */
export const Evidence = z.strictObject({
  file: z.string().min(1),
  line: z.int().positive(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * One field of an object type. `type` is a display string; every named type it
 * mentions is listed in `refs`, and the UI expands those from `Model.types`.
 * A field named `…` spreads the named type in `type` into the parent object.
 */
export const Field = z.strictObject({
  name: z.string(),
  type: z.string(),
  optional: z.boolean().default(false),
  note: z.string().optional(),
  refs: z.array(z.string()).default([]),
});
export type Field = z.infer<typeof Field>;

/** A type as it appears at a use site: a display string, or an inline object. */
export const TypeExpr = z.strictObject({
  type: z.string(),
  refs: z.array(z.string()).default([]),
  fields: z.array(Field).optional(),
});
export type TypeExpr = z.infer<typeof TypeExpr>;

/** A named type from the code base. `alias` holds non-object types such as enums. */
export const NamedType = z.strictObject({
  name: z.string(),
  fields: z.array(Field).optional(),
  alias: z.string().optional(),
  refs: z.array(z.string()).default([]),
  evidence: Evidence,
});
export type NamedType = z.infer<typeof NamedType>;

export const ElementKind = z.enum([
  'command',
  'query',
  'subscription',
  'worker',
  'aggregate',
  'event',
  'projection',
  'table',
  'external',
]);
export type ElementKind = z.infer<typeof ElementKind>;

export const EdgeKind = z.enum([
  'decides',
  'emits',
  'handles',
  'writes',
  'streams',
  'reads',
  'calls',
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

const base = {
  /** Stable across extractions: `<domain>:<kind>:<name>`. */
  id: z.string().min(1),
  /** Owning domain id, or null for things outside every explored domain. */
  domain: z.string().nullable(),
  /** Full name, for example `organizations.create`. */
  name: z.string().min(1),
  /** Short name shown on the node, for example `create`. */
  label: z.string().min(1),
  description: z.string().optional(),
  evidence: Evidence,
};

export const Http = z.strictObject({ method: z.string(), path: z.string() });
export type Http = z.infer<typeof Http>;

export const RouteResponse = z.strictObject({ status: z.int(), body: TypeExpr });
export type RouteResponse = z.infer<typeof RouteResponse>;

export const RouteErrors = z.strictObject({
  statuses: z.array(z.int()),
  codes: z.array(z.string()),
});
export type RouteErrors = z.infer<typeof RouteErrors>;

const route = {
  ...base,
  /** Absent for contracts that are only callable in process. */
  http: Http.optional(),
  permission: z.string().optional(),
  input: TypeExpr.optional(),
  responses: z.array(RouteResponse).default([]),
  errors: RouteErrors.optional(),
};

export const CommandElement = z.strictObject({
  ...route,
  kind: z.literal('command'),
  /** Event ids this command appends. Keeps lineage exact when one aggregate has many events. */
  appends: z.array(z.string()).default([]),
});
export const QueryElement = z.strictObject({ ...route, kind: z.literal('query') });
export const WorkerElement = z.strictObject({
  ...base,
  kind: z.literal('worker'),
  /** `workflow`: a step that a workflow engine runs, such as a Temporal activity. */
  trigger: z.enum(['loop', 'startup', 'migration', 'schedule', 'event', 'workflow']),
  /** A cron expression or an interval, when the trigger is a schedule. */
  schedule: z.string().optional(),
  appends: z.array(z.string()).default([]),
});
export const AggregateElement = z.strictObject({
  ...base,
  kind: z.literal('aggregate'),
  state: TypeExpr.optional(),
  storage: z
    .strictObject({
      kind: z.string(),
      stream: z.string().optional(),
      snapshot: z.boolean().default(false),
    })
    .optional(),
});
export const EventElement = z.strictObject({
  ...base,
  kind: z.literal('event'),
  payload: TypeExpr.optional(),
  schemaVersion: z.int().optional(),
});
export const Entity = z.strictObject({
  name: z.string(),
  permissions: z.array(z.string()).default([]),
  row: TypeExpr.optional(),
  consumer: z.string().optional(),
  search: z.array(z.string()).optional(),
});
export type Entity = z.infer<typeof Entity>;
export const ProjectionElement = z.strictObject({
  ...base,
  kind: z.literal('projection'),
  entity: Entity.optional(),
});
export const Column = z.strictObject({
  name: z.string(),
  type: z.string(),
  primaryKey: z.boolean().default(false),
  notNull: z.boolean().default(false),
  note: z.string().optional(),
});
export type Column = z.infer<typeof Column>;
export const TableIndex = z.strictObject({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean().default(false),
});
export type TableIndex = z.infer<typeof TableIndex>;
export const TableElement = z.strictObject({
  ...base,
  kind: z.literal('table'),
  schema: z.string().optional(),
  columns: z.array(Column),
  primaryKey: z.array(z.string()).default([]),
  indexes: z.array(TableIndex).default([]),
});
export const SubscriptionElement = z.strictObject({
  ...base,
  kind: z.literal('subscription'),
  row: TypeExpr.optional(),
  path: z.string().optional(),
  permission: z.string().optional(),
});
export const ExternalElement = z.strictObject({
  ...base,
  kind: z.literal('external'),
  /** `system` is something outside the repo; `domain` is a collapsed, unexplored domain. */
  system: z.enum(['system', 'domain']),
});

export const Element = z.discriminatedUnion('kind', [
  CommandElement,
  QueryElement,
  WorkerElement,
  AggregateElement,
  EventElement,
  ProjectionElement,
  TableElement,
  SubscriptionElement,
  ExternalElement,
]);
export type Element = z.infer<typeof Element>;
export type CommandElement = z.infer<typeof CommandElement>;
export type QueryElement = z.infer<typeof QueryElement>;
export type WorkerElement = z.infer<typeof WorkerElement>;
export type AggregateElement = z.infer<typeof AggregateElement>;
export type EventElement = z.infer<typeof EventElement>;
export type ProjectionElement = z.infer<typeof ProjectionElement>;
export type TableElement = z.infer<typeof TableElement>;
export type SubscriptionElement = z.infer<typeof SubscriptionElement>;
export type ExternalElement = z.infer<typeof ExternalElement>;
export type RouteElement = CommandElement | QueryElement;

export const Edge = z.strictObject({
  source: z.string(),
  target: z.string(),
  kind: EdgeKind,
  evidence: Evidence,
  /** How many underlying relations a collapsed edge stands for. */
  count: z.int().positive().optional(),
  label: z.string().optional(),
});
export type Edge = z.infer<typeof Edge>;

export const Domain = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string(),
  description: z.string().optional(),
});
export type Domain = z.infer<typeof Domain>;

/** An architecture warning, shown as a badge on `element` plus dashed ghost edges. */
export const Check = z.strictObject({
  id: z.string(),
  rule: z.literal('unhandled-event'),
  element: z.string(),
  /** Elements that were expected to be connected to `element` but are not. */
  missing: z.array(z.string()),
  /** Display names for the message: the event, its aggregate and the consumers. */
  detail: z.strictObject({
    event: z.string(),
    aggregate: z.string(),
    consumers: z.array(z.string()),
    handledSiblings: z.int(),
  }),
  /**
   * The finding was there before watching began, or was accepted since. It is
   * still listed, but drawn quietly: no ghost edge and no line in the feed.
   */
  known: z.boolean().default(false),
});
export type Check = z.infer<typeof Check>;

export const Model = z.strictObject({
  version: z.literal(1),
  repo: z.strictObject({
    name: z.string(),
    branch: z.string().optional(),
    adapter: z.string().optional(),
  }),
  /** Domains drawn in full. */
  domains: z.array(Domain),
  /** Domains folded away: into a block when something explored touches them, otherwise off the map. */
  collapsed: z.array(Domain).default([]),
  elements: z.array(Element),
  edges: z.array(Edge),
  types: z.record(z.string(), NamedType).default({}),
  checks: z.array(Check).default([]),
});
export type Model = z.infer<typeof Model>;

/** Fixed lanes, left to right. They follow the data flow. */
export const LANES = [
  'worker',
  'query',
  'command',
  'aggregate',
  'event',
  'projection',
  'table',
  'subscription',
] as const satisfies readonly ElementKind[];
export type LaneKind = (typeof LANES)[number];

export const elementId = (domain: string | null, kind: ElementKind, name: string) =>
  `${domain ?? 'external'}:${kind}:${name}`;

/** `.code-atlas/domains.yaml`: overrides for folder-derived domains. */
export const DomainsConfig = z.strictObject({
  /** Folder globs that hold one domain per sub-folder. Default: the adapter's own. */
  roots: z.array(z.string()).optional(),
  /** Per-domain overrides, keyed by folder name. */
  domains: z
    .record(
      z.string(),
      z.strictObject({
        name: z.string().optional(),
        description: z.string().optional(),
        /** Extra folders that belong to this domain, relative to the repo root. */
        paths: z.array(z.string()).optional(),
        /** Move this folder's elements into another domain. */
        mergeInto: z.string().optional(),
        /** Leave the folder off the map entirely. */
        ignore: z.boolean().optional(),
      }),
    )
    .default({}),
  /** When set, only these domains are drawn in full; the rest collapse into blocks. */
  explore: z.array(z.string()).optional(),
  checks: z
    .strictObject({
      /** Events that are known to be unhandled on purpose, by name (`auth.user-deleted`) or id. */
      ignore: z.array(z.string()).default([]),
      /**
       * `new` (the default) raises only findings that appear after the first
       * run; what was already there is kept as known. `all` raises everything.
       */
      mode: z.enum(['new', 'all']).default('new'),
    })
    .optional(),
});
export type DomainsConfig = z.infer<typeof DomainsConfig>;
