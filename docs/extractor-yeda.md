# The Yeda extractor

`packages/extractor-yeda` reads a Yeda monorepo and produces the model. It uses the TypeScript
compiler API as a parser only. There is no type checker and no program: a full extraction of
about 450 files takes roughly half a second.

## How it reads code

Three layers, each in one file.

1. **`workspace.ts`** parses files on demand and resolves names: local declarations, imports,
   re-exports (`export *`, `export { a as b } from`) and the `paths` in `tsconfig.base.json`.
2. **`evaluate.ts`** is a small symbolic evaluator. It does not run code. It follows a name to its
   value, inlines functions written under `features/`, substitutes their arguments and evaluates
   template literals, object spreads, `array.map(...)`, `Object.values(...)` and member access.
   A call to a platform function (anything outside `features/`) stays an opaque *call value* that
   remembers its name and arguments. Whatever it cannot follow becomes `unknown`.
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
| A function that calls `appendToStream(s)` and is reachable from `withStart` | Worker. `loop` inside `while (!stopped)` or `setInterval`, `migration` when the name says backfill or migrate, `startup` otherwise. |
| `invoke(Route)`, `context.call(Route)` to another feature | `calls` edge. |
| A call on a client from `@/platform/zitadel`, `@aws-sdk/*`, `@grpc/*`, `@temporalio/*`, `node:https` | `calls` edge to an external system. |

## Types

`types.ts` turns evaluated Zod schemas into fields. A top-level schema with a capitalised name
that is not a scalar becomes a named type. Scalars (`OrganizationId = z.string().min(1).max(200)`)
are inlined with their constraints as a note. `X.extend({...})` shows as `…X` plus the new fields.
`pick`, `omit`, `partial`, `X.shape.field` and `Route.input` are resolved. When two features export
a type under the same name, identical definitions share the name and different ones become
`domain.Name`.

## Limits

- Workers are functions that append events. A background loop that only writes tables or only
  calls an external system is not drawn yet.
- A read or a write is attributed by reference: any use of a table in reachable code counts.
- The read/write split for external calls is a guess from an explicit HTTP verb or the method
  name (`get`, `find`, `sign`, … are reads).
- Routes without a `localRoute` registration are skipped and listed in `stats.skipped`.

## Tests

- `test/mini.test.ts` runs on `test/fixtures/mini`, a tiny repository in the same DSL. It is
  self-contained and always runs.
- `test/yeda.test.ts` runs on the real monorepo, features/organizations and features/tags. Set
  `YEDA_PATH` or write the path into `.yeda-path` at the repository root. Without it the suite
  skips.

To look at what the extractor finds:

```bash
pnpm tsx packages/extractor-yeda/scripts/inspect.ts <repo> organizations,tags --edges
```
