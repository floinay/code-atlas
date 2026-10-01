# Code Atlas

A live map of a codebase's architecture, for people who steer coding agents instead of writing the code.

Code Atlas reads the code and draws its domains. Inside each domain it shows commands, queries,
subscriptions, workers, aggregates, events, projections and tables, the edges between them and the
types they carry. The map updates while files change and keeps its layout, so you can watch an
agent work and see what it touched.

It works for event-sourced systems and for plain CRUD apps. A CRUD app is `command → table → query`:
the middle lanes simply stay empty.

## Status

Early. See [CHANGELOG.md](CHANGELOG.md) for what each milestone added.

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

## Layout

| Path | What it is |
| --- | --- |
| `packages/model` | The model (Zod schemas) and everything computed from it: bundling, lineage, layout, checks, diff. |
| `packages/extractor-yeda` | Reads a Yeda monorepo with the TypeScript compiler API. |
| `packages/cli` | `code-atlas serve` and `code-atlas extract`. |
| `apps/web` | The map: React, Vite and a hand-written SVG canvas. |
| `docs` | [The model](docs/model.md), [the web app](docs/web.md), [the CLI and live updates](docs/cli.md), [the Yeda extractor](docs/extractor-yeda.md). |

## Develop

```bash
pnpm check        # typecheck, lint and tests
```
