# Adapters

An adapter turns a repository into the model. The CLI knows two:

| Adapter | Recognises | Package |
| --- | --- | --- |
| `yeda` | `features/` plus `libs/platform/route-contracts` | `packages/extractor-yeda` ([details](extractor-yeda.md)) |
| `express-prisma` | `express` in `package.json` plus a `schema.prisma` | `packages/extractor-express-prisma` |

They share `packages/extractor-kit`: the workspace that resolves names, the symbolic evaluator,
the walk over what a function reaches, and the reader that turns Zod schemas into types. None of
that knows about Yeda or Express.

## The contract

```ts
type Extractor = {
  extract(): { model: Model; stats: { files: number; ms: number } };
  invalidate(files: string[]): void;   // repo-relative paths that changed
  watch: string[];                     // folders `serve` should watch
};
```

Register it in `packages/cli/src/adapters.ts` with a `detect(root)` function. Everything after the
model is shared: checks, collapsing, layout, diff, the server and the web app.

Two rules hold for every adapter:

1. **Evidence or nothing.** Each element and edge points at a file and a line.
2. **Stable ids.** `<domain>:<kind>:<name>`, the same on every run, so the layout and the "new"
   badges work.

## Express + Prisma

A plain CRUD app has no aggregates, events or projections. Its map is
`command → table → query`, and the three middle lanes stay empty. `examples/express-prisma` is
the sample; `pnpm atlas serve examples/express-prisma` shows it.

| Code | Model |
| --- | --- |
| `src/modules/<name>` (or `src/features`, `src/domains`, `modules`) | Domain. Files outside every module go to `app`. Without such a folder, the first path segment of the route is the domain. |
| `router.get('/path', ...handlers)`, also `router.route('/path').get(h).patch(h)` | Command or query. The path is resolved through `app.use('/prefix', router)`, however deep. |
| A handler that reaches a Prisma write, or an external write | **Command**. Otherwise **query**, whatever the HTTP verb: `POST /search` is a query. |
| `model X` in `schema.prisma` | Table: `@@map` and `@map` names, `@id` and `@@id`, `@unique`, `@@unique`, `@@index`, defaults. |
| `prisma.task.update(...)` reachable from a handler | `writes` edge. `findMany`, `findUnique`, `count`, `groupBy`, … are `reads`, drawn into queries only. |
| `include: { comments: true }` | A read of the related table. |
| `data: { members: { create: … } }` | A write to the related table. |
| `Schema.parse(req.body)` | The route's input, next to its path parameters. |
| `res.json(x)`, `res.status(201).json(x)`, `res.sendStatus(204)` | Responses. When `x` comes from a Prisma call, its type is the model: `Task`, `Task[]`, `Task \| null`. |
| `res.status(404).json({ error: 'not_found' })` | Error statuses and codes, including those of guards. |
| `requireAuth`, `requireRole('admin')` on the router or the route | Permission. |
| `cron.schedule('0 3 * * *', fn)`, `setInterval(fn, ms)` | Worker with a schedule, when it writes. |
| A call on a client from `nodemailer`, `stripe`, `@aws-sdk/*`, `axios`, … | `calls` edge to an external system. |

A route is named after the function its inline handler hands the work to (`createTask`), and after
its method and path when there is none.

The schema is one file for the whole app, so a table goes to the module named after it
(`projects` owns `Project` and `ProjectMember`), or else to the module that writes it most.

### Limits

- Raw SQL (`$queryRaw`, `$executeRaw`) is not read.
- A global `fetch` to another service is not an external system yet.
- Response types come from Prisma calls and object literals. A value that went through a mapper is `unknown`.
- Controllers written as classes are not followed.

## Writing another adapter

Start from `packages/extractor-express-prisma/src/extract.ts`; it is about 500 lines.

1. Find the definitions. Walk the source for the calls that declare things (`router.get`,
   `defineRoute`, `@Controller`), and evaluate their arguments with `Evaluator` so helpers,
   constants and factories resolve.
2. Follow behaviour. `Reach.analyze(handler)` returns facts: tables touched, calls on opaque
   values (`facts.opaque`, where a Prisma or storage call shows up), external systems, functions
   entered. Map them to edges.
3. Read types with `TypeReader` if the code base uses Zod; otherwise build `TypeExpr` values
   yourself, as the Prisma models are built here.
4. Write tests against a small sample repository in the same style, kept under the adapter's
   `test/` folder or in `examples/`.
