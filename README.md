# Code Atlas

A live map of a codebase's architecture, for people who steer coding agents instead of writing the code.

Code Atlas reads the code and draws its domains. Inside each domain it shows commands, queries,
subscriptions, workers, aggregates, events, projections and tables, the edges between them and the
types they carry. The map updates while files change and keeps its layout, so you can watch an
agent work and see what it touched.

It works for event-sourced systems and for plain CRUD apps. A CRUD app is `command → table → query`:
the middle lanes simply stay empty.

## Status

Early, and working end to end on two kinds of code base. See [CHANGELOG.md](CHANGELOG.md) for what
each milestone added. There is no license yet.

## Run it

```bash
pnpm install
pnpm build                          # builds the web app once
pnpm atlas serve ../my-repo         # http://localhost:4400, follows file changes
```

`serve` extracts the repository, serves the map and watches the files. When something changes it
extracts again, works out what is new, keeps every node where it was and pushes the update to the
browser. New elements get a badge; a new event that a projection forgot gets a warning.

It keeps the layout in `<repo>/.code-atlas/layout.json`. Pass `--state-dir` to keep it elsewhere,
for example when the repository must stay untouched.

```bash
pnpm atlas serve ../my-repo --only organizations,tags    # two domains in full, neighbours collapsed
pnpm atlas extract ../my-repo --out model.json           # the model as a file
pnpm dev                                                 # web app with hot reload, on :5273
```

`pnpm dev` talks to a running `serve` on port 4400. Without one it shows the bundled fixture and a
demo of an agent adding a feature. To look at a model file, put it in `apps/web/public` and open
`http://localhost:5273/?model=/model.json`.

## What it reads

| Adapter | For | Sample |
| --- | --- | --- |
| `yeda` | An event-sourced Nx monorepo written in the Yeda DSL: routes, aggregates, events, projections, Drizzle tables. | `packages/extractor-yeda/test/fixtures/mini` |
| `express-prisma` | A plain Express + Prisma app. Its map is `command → table → query`. | `examples/express-prisma` |

```bash
pnpm atlas serve examples/express-prisma
```

The adapter is picked by looking at the repository. [docs/adapters.md](docs/adapters.md) says how
each one reads code and how to write another.

## Layout

| Path | What it is |
| --- | --- |
| `packages/model` | The model (Zod schemas) and everything computed from it: bundling, lineage, layout, checks, diff. |
| `packages/extractor-kit` | What adapters share: name resolution without a type checker, a symbolic evaluator, a reachability walk, a Zod type reader. |
| `packages/extractor-yeda` | Reads a Yeda monorepo. |
| `packages/extractor-express-prisma` | Reads an Express + Prisma app. |
| `packages/cli` | `code-atlas serve` and `code-atlas extract`. |
| `apps/web` | The map: React, Vite and a hand-written SVG canvas. |
| `examples/express-prisma` | A small CRUD app to map. |
| `docs` | [The model](docs/model.md), [the web app](docs/web.md), [the CLI and live updates](docs/cli.md), [adapters](docs/adapters.md), [the Yeda extractor](docs/extractor-yeda.md). |

## Develop

```bash
pnpm check        # typecheck, lint and tests
```
