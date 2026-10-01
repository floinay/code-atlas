# Changelog

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
