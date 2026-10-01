# Changelog

## Exploring domains, known findings, open in editor

- Domains are collapsed and explored from the map: a control in each region's header, toggles in
  the sidebar ("only this domain", "all"), buttons in the panel of a block, a double click on a
  block. The choice is sent to the server, shared by every open tab and saved.
- Each selection of explored domains is a view with its own remembered layout. A new view is
  packed afresh, with every region laid out inside as it already is elsewhere.
- Checks keep a baseline. The first `serve` records what is already wrong as known; only findings
  that appear later are raised. Known ones stay as a grey badge and can be raised again; new ones
  can be accepted. `checks.mode: all` turns this off.
- File paths in the detail panel open the editor at the line (`--editor`, `$CODE_ATLAS_EDITOR`,
  or the editor that is running), and a button copies `path:line`.
- `--config` reads the domains file from outside the repository.
- `serve` listens on `127.0.0.1` (`--host` changes it) and answers only requests made from its own
  page, WebSocket included.
- `layout.json` is now version 2: views, the explored domains, the baseline. A version 1 file is
  read as the layout of the current view.

## Milestone 5: a second adapter, for Express + Prisma

- `packages/extractor-kit`: the workspace, evaluator, reachability walk and Zod reader moved out of
  the Yeda adapter, so adapters share them.
- `packages/extractor-express-prisma`: Express routers (nested mounts, `route()` chains, guards),
  Prisma models as tables, Prisma calls as reads and writes (including `include` and nested
  writes), Zod bodies as input, responses typed from Prisma, cron jobs as workers, library clients
  as external systems.
- `examples/express-prisma`: Taskboard, a CRUD app with four domains. Its map is
  `command → table → query`; the aggregate, event and projection lanes stay empty.
- The CLI picks the adapter by looking at the repository.
- Layout: the number of region columns now follows the shape of the map, so four small domains
  stack in one column and thirteen large ones spread over four.
- `serve` ignores duplicate file events, and ignore rules no longer look at where the repository
  itself lives.
- Workers can carry a schedule. Links to collapsed domains show how many elements they stand for.

## Milestone 4: serve, watch, live updates, stable layout

- `code-atlas serve <repo>`: extracts, serves the built web app, watches files with chokidar,
  extracts again on change and pushes the model, its layout and the diff over a WebSocket.
- Incremental: only changed files are parsed again; an update of the full Yeda map takes about 0.25 s.
- The layout is computed from the previous one and saved to `.code-atlas/layout.json`
  (`--state-dir` moves it). New elements take the next free slot and get a badge; nothing else moves.
- The feed lists what was added, removed or changed, new warnings, and file changes that left the
  map as it was. A failed extraction keeps the last good model.
- Tests run a real server on a copy of the mini repository and edit files under it.

## Milestone 3: every Yeda feature

- The versioning platform: generated events, the three projections of each storage, their tables
  and live collections, and storage calls as appends and reads. Forms, settings and websites are
  now drawn in full.
- Route factories with template names, `defineFeature` in object form, handlers registered through
  `.map(...)` and computed members, parameter defaults and `let x = null` assigned at start.
- `listenEvents` consumers as projections. Workers found from what the start hook calls: loops,
  startup tasks and migrations, including ones that only write tables or external systems.
- External systems: ZITADEL, S3, OpenBao and the gRPC domain manager, with writes told from reads
  by HTTP verb, SDK command or name.
- `.code-atlas/domains.yaml`: `roots`, `explore`, per-domain `name`, `description`, `paths`,
  `ignore`, `mergeInto`, and `checks.ignore`.
- A full extract of Yeda main: 13 domains, 508 elements, 910 edges from 448 files in about 0.4 s.
- Web app: domain names take over as large labels when the map is zoomed out past readable nodes.

## Milestone 2: Yeda extractor for organizations and tags

- `@code-atlas/extractor-yeda`: workspace resolver, a symbolic evaluator that inlines feature
  functions, a Zod-to-type reader and a reachability walk over handlers. No type checker.
- Extracts routes (command or query by what the handler does), the events each command appends,
  aggregates, events, projections with their entity, tables, subscriptions, workers, cross-domain
  calls and external systems, each with file and line.
- On Yeda main, organizations + tags give 72 elements and 114 edges on the map. The prototype had
  71 and 112; the code has since gained `logo.sign-upload` and turned `provisioning.retry` into a
  read.
- `code-atlas extract <repo> --out model.json [--only a,b]`, and `.code-atlas/domains.yaml`.
- The web app opens a model file with `?model=<url>`.
- Tests: a self-contained mini repository in the Yeda DSL, plus integration tests on the real
  monorepo that skip when it is not present.

## Milestone 1: scaffold, model, web app on a fixture

- pnpm workspace: `packages/model`, `packages/extractor-yeda`, `packages/cli`, `apps/web`. TypeScript strict, ESM, Vitest, ESLint.
- `@code-atlas/model`: Zod schemas for domains, nine element kinds, seven edge kinds, types and
  evidence. Pure functions on top: `buildView` (bundling), `lineage` and `impact`, `computeLayout`
  (stable lanes), `runChecks` (unhandled event), `diffModels`, `collapseDomains`.
- Fixture ported from the design prototype: Organizations and Tags, 71 elements, which bundle into
  68 nodes and 112 edges.
- Web app ported from the prototype: regions and lanes, counter-scaled labels, hover lineage, detail
  panel with the type viewer, kind filters, search (`/`), live feed, dark and light themes, and the
  "agent adds a feature" demo that runs the same update path live changes will use.
