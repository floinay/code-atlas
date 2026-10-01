# The model

The model is one JSON document, validated by the Zod schemas in `packages/model/src/schema.ts`.
Adapters produce it, the CLI serves it, the web app draws it.

## Elements

| Kind | What it is | What it carries |
| --- | --- | --- |
| `command` | A route that changes state. | HTTP, permission, input, responses per status, error codes, **the events it appends**. |
| `query` | A route that only loads and reads. | HTTP, permission, input, responses, error codes. |
| `subscription` | A live stream to clients. | Row type, path, permission. |
| `worker` | A background loop, startup task, migration, scheduled job or workflow step. | Trigger, schedule, the events it appends. |
| `aggregate` | State decided by commands. | State type, storage. |
| `event` | A fact an aggregate emits. | Payload, schema version. |
| `projection` | A read model built from events. | Entity: name, permissions, row type, consumer. |
| `table` | A database table. | Columns, primary key, indexes. |
| `external` | Something outside the explored domains. | `system` or a collapsed `domain`. |

Element ids are `<domain>:<kind>:<name>` and stay the same between extractions. The layout and the
"new" badges depend on that.

## Edges

| Kind | From → to |
| --- | --- |
| `decides` | command or worker → aggregate |
| `emits` | aggregate → event |
| `handles` | event → projection |
| `writes` | projection → table (in a CRUD app: command → table) |
| `streams` | projection → subscription |
| `reads` | aggregate, table or projection → query |
| `calls` | anything → another domain's contract or an external system |

## Evidence

Every element and every edge has `evidence: { file, line }`. An adapter that cannot point at a line
must not emit the fact.

## Why commands store the events they append

One aggregate can emit many events. If lineage walked `command → aggregate → every event of that
aggregate`, hovering `tags.create` would light up `tag-deleted`. So commands and workers list the
events they append, and lineage follows that list. The `decides` edge still exists; it is what is
drawn between the command and the aggregate.

## Types

Fields are `{ name, type, optional, note, refs }`. `type` is a display string. `refs` lists the
named types it mentions; the web app looks those up in `model.types` and lets you expand them.
A field named `…` spreads a named type into its parent.

## Computed from the model

These live in `packages/model` and have no I/O, so the CLI and the browser share them.

- `buildView(model)`: the graph that is drawn. Commands or queries of one domain with identical
  edges, identical appended events and identical success responses become one node with `×N`.
  Failed checks become a badge and dashed ghost edges.
- `lineage(view, id)` and `impact(view, id)`: what a node depends on and what depends on it.
- `computeLayout(view, domains, previous?)`: see below.
- `runChecks(model)`: an event is flagged when some consumer handles every other event of its
  aggregate (at least two) but not this one.
- `applyBaseline(checks, baseline)` and `pruneBaseline(checks, baseline)`: mark the findings that
  are already known, and forget the ones that were fixed.
- `collapseDomains(model, explore)`: folds unexplored domains into blocks with counted edges, and
  lists them in `model.collapsed`.
- `project(full, explore, state)`: the map for one selection of explored domains. It collapses,
  builds the view and computes the layout from the saved state.
- `diffModels(previous, next)`: added, removed and changed elements and edges. Evidence line shifts
  alone are not a change.

## Stable layout

The first layout packs each lane and centres it in its region. After that the layout is an input:

- an existing node keeps its position;
- a new node takes the next free slot in its lane: a hole left by a removed node if it fits,
  otherwise below the last node;
- a region grows downwards and only pushes the regions below it when it outgrows the gap;
- a new domain goes to the shortest column.

The number of columns is chosen once, from the shape of the map: the count whose overall width
and height come closest to a screen.

## Views

A selection of explored domains is a view, and every view has its own layout. Thirteen regions in
four columns and two regions side by side cannot share positions: a region is about 2300 units
wide, so two domains kept at their places in the full map could end up a screen apart.

- A view keeps its layout, so the rules above hold inside it and returning to a view shows it as
  it was left.
- A view opened for the first time is packed afresh. Its regions are laid out inside as they are
  in the views that already show them, so a node sits at the same place in its domain everywhere.
- The twelve most recently used views are kept.

The saved state (`AtlasState`, in `.code-atlas/layout.json`):

```ts
{
  version: 2,
  explore?: string[],             // chosen in the browser; [] means "all, on purpose"
  views: Record<string, Layout>,  // key: "*" or the sorted ids, least recently used first
  baseline?: string[],            // known findings, as "event>consumer"
}
```
