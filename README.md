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
pnpm dev          # the web app on http://localhost:5273, with the bundled fixture
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/model` | The model (Zod schemas) and everything computed from it: bundling, lineage, layout, checks, diff. |
| `packages/extractor-yeda` | Reads a Yeda monorepo with the TypeScript compiler API. |
| `packages/cli` | `code-atlas serve` and `code-atlas extract`. |
| `apps/web` | The map: React, Vite and a hand-written SVG canvas. |
| `docs` | [The model](docs/model.md), [the web app](docs/web.md). |

## Develop

```bash
pnpm check        # typecheck, lint and tests
```
