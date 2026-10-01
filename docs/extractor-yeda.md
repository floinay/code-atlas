# The Yeda extractor

`packages/extractor-yeda` reads a Yeda monorepo and produces the model. It uses the TypeScript
compiler API as a parser only. There is no type checker and no program: a full extraction of
about 450 files takes roughly half a second.

## How it reads code

Three layers from `packages/extractor-kit`, each in one file, and the Yeda vocabulary on top in
`packages/extractor-yeda/src/extract.ts`.

1. **`workspace.ts`** parses files on demand and resolves names: local declarations, imports,
   re-exports (`export *`, `export { a as b } from`) and the `paths` in `tsconfig.base.json`.
2. **`evaluate.ts`** is a small symbolic evaluator. It does not run code. It follows a name to its
   value, inlines functions written under `features/`, substitutes their arguments and evaluates
   template literals, object spreads, `array.map(...)`, `Object.values(...)`, member access,
   parameter defaults and `let` variables assigned later. A call to a platform function (anything
   outside `features/`) stays an opaque *call value* that remembers its name and arguments.
   Whatever it cannot follow becomes `unknown`.
3. **`reach.ts`** walks a handler and everything it calls, with arguments bound. A closure that is
   declared but never called is not followed.

The evaluator is why factories work without special cases:

```ts
const settingsRoutes = (prefix, path) => ({ get: defineRoute({ name: `${prefix}.get` }, http('get')) });
export const UserSettingsRoutes = settingsRoutes('settings.user', 'settings/user');
// → a route named settings.user.get with path /api/settings/user/get
```

and why `runtime.upstream.get(id)` is known to be a ZITADEL call: `runtime` is assigned in the
start hook, `upstream` is `organizationClient(createZitadelApi(...))`, and following `get` leads
to a call on the value `createZitadelApi` returned.

## What becomes what

| Code | Model |
| --- | --- |
| `features/<name>` | Domain. Its description is the first sentence of the feature README. |
| `defineRoute(config, ...mixins)` | Command or query. HTTP from `withHttp`, permission from `withPermission`, description from JSDoc or `withMcp`. |
| `localRoute(Route, handler)` | Decides the kind: a handler that drafts events, writes a table or calls an external system with a write is a **command**; one that only loads and reads is a **query**. A route that calls a command is a command. |
| `Event.draft(...)` reachable from a handler | The command's `appends`, and a `decides` edge to the event's aggregate. |
| `loadAggregate({ definition })` in a query | `reads` edge from the aggregate. |
| A Drizzle table referenced in a query | `reads` edge from the table. `insert`, `update` and `delete` are writes. |
| `defineEvent` | Event. Payload from the Zod schema. Identity spread from a constant is resolved. |
| `defineAggregateContract` + `defineAggregate` | Aggregate. State from `schema`, `emits` edges from `events`. An event whose stream type has no contract gets an aggregate named after the type. |
| `defineEntity` + `withProjection(Live, { events, consumerName, handle })` | Projection with its entity card. `handles` from `events` (arrays, spreads, `on`, `combine`, `handlers.flatMap(h => h.events)`, another entity's handler). `writes` from the tables `handle` reaches. |
| `defineLiveProjection({ syncRoute })` | Subscription and a `streams` edge. |
| `schema.table(name, columns, constraints)` | Table with columns, primary key and indexes. |
| A function the start hook calls that changes state | Worker. See below. |
| `listenEvents(...handlers, { projection })` in the start hook | Projection without an entity, with `handles` from the `on(...)` handlers and `writes` from what they reach. |
| `invoke(Route)`, `context.call(Route)` to another feature | `calls` edge. |
| A call on a client from `@/platform/zitadel`, `@aws-sdk/*`, `@grpc/*`, `@temporalio/*`, `node:https` | `calls` edge to an external system. |

### Workers

Background work is whatever `withStart` (or `start` in the object form of `defineFeature`) calls
that changes state: appends events, writes a table or writes to an external system.

- A function called straight from the start hook is a candidate. Closures written inside the hook
  are part of the hook, so the candidates are the named functions behind them.
- `loop` when the call sits in `while (!stopped)` or the function runs a loop or interval itself;
  `startup` otherwise.
- A function whose name says `migrate` or `backfill` is a `migration` and is kept apart from the
  function that calls it, so `adoptOrganizations` does not own the slug backfill's events.
- A method of an object a factory returned is named after both: `identitySync.step`.

### The versioning platform

`@/platform/aggregate-versioning` generates most of what forms, settings and websites are made of,
so none of it is written in the feature. The extractor knows the platform's shape:

| Code | Model |
| --- | --- |
| `defineAggregateContract(base, withVersioning({ key, lifecycle }))` | The aggregate, plus generated events `<key>.created`, `.draft-saved`, `.draft-restored`, `.published`, `.unpublished`, and `.archived` / `.unarchived` / `.deleted` / `.suspended` / `.resumed` when the lifecycle option enables them. |
| `createVersioningStorage(Aggregate, { projections, tables })` | Three projections (drafts, published, versions) that handle every event of the aggregate, each writing its table and streaming to a live collection. |
| `storage.saveDraft(...)`, `publish`, `archive`, … in a handler | The command appends the matching generated event. `storage[command](...)` works when `command` is bound per route. |
| `storage.getDraft(...)`, `getPublished`, `getVersion`, `listVersions` | `reads` edge from the projection to the query. |
| `Contract.versioningEvents.created.draft(...)` | An append of that generated event. |
| `defineVersioningTables(Projections, { schema, prefix })` | The one platform function the evaluator reads through: it builds `<prefix>_drafts`, `_published` and `_versions` from its arguments. The bookkeeping table is left out. |

## External writes

A call to an external system counts as a write only with evidence, in this order: an explicit HTTP
verb other than GET; an SDK command class (`PutObjectCommand` writes, `GetObjectCommand` reads);
for REST helpers `api(path, body)`, a body that is not a query; a name that says so (`create`,
`update`, `release`, `ensure`, …). Signing a URL is a read. Anything else is a read.

## Configuration

`.code-atlas/domains.yaml` in the mapped repository. Every key is optional.

```yaml
roots: [features]            # folders that hold one domain per sub-folder
explore: [organizations, tags]  # draw these in full, collapse the rest into blocks
domains:
  organizations:
    name: Organizations
    description: Creation, lifecycle and ZITADEL sync of organizations.
  notifications:
    paths: [apps/backend-service/src/notifications.ts]   # extra files of this domain
  test-orchestration:
    ignore: true
  legacy-billing:
    mergeInto: billing
checks:
  ignore: [auth.user-authentication-observed]   # known and intended
```

## Types

`types.ts` in the kit turns evaluated Zod schemas into fields. A top-level schema with a capitalised name
that is not a scalar becomes a named type. Scalars (`OrganizationId = z.string().min(1).max(200)`)
are inlined with their constraints as a note. `X.extend({...})` shows as `…X` plus the new fields.
`pick`, `omit`, `partial`, `X.shape.field` and `Route.input` are resolved. When two features export
a type under the same name, identical definitions share the name and different ones become
`domain.Name`.

## Limits

- Routes without a `localRoute` registration are skipped and listed in `stats.skipped`. On Yeda
  that is the event store's transport contract (implemented in another service) and the one
  route test-orchestration forwards.
- A read or a write is attributed by reference: any use of a table in reachable code counts.
- External writes are a judgement from names and verbs, as described above.
- The versioning platform is modelled by hand. A change to its method names needs a change here.
- Work wired up outside the feature folders (Temporal activities and the Mailtrap client in
  `apps/backend-service`) is not seen unless those paths are added to a domain in the config.
- Koa middleware returned from a start hook (webhooks, file delivery) is not on the map.

## Tests

- `test/mini.test.ts` runs on `test/fixtures/mini`, a tiny repository in the same DSL. It is
  self-contained and always runs.
- `test/yeda.test.ts` runs on the real monorepo: organizations and tags in detail, then every feature. Set
  `YEDA_PATH` or write the path into `.yeda-path` at the repository root. Without it the suite
  skips.

To look at what the extractor finds:

```bash
pnpm tsx packages/extractor-yeda/scripts/inspect.ts <repo> organizations,tags --edges
```
