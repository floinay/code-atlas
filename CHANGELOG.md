# Changelog

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
