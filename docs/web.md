# The web app

React and Vite. The canvas is hand-written SVG.

## Why SVG and not React Flow

- **The layout is ours.** Lanes are fixed and positions come from `computeLayout`. React Flow's
  value is free-form graphs with dragging, handles and its own viewport. None of that is used here.
- **Labels counter-scale.** Names must stay readable when zoomed out, so a label's font size,
  position and text depend on the camera scale. That needs direct control over each `<text>`.
  React Flow scales nodes as a whole.
- **Tables are real tables** with a header, column rows and PK marks, and their height comes from
  the column count. With plain SVG the layout function and the renderer share one geometry.
- **Fewer dependencies.** The canvas is about 400 lines.

## How it stays fast

- Pan and zoom write the camera to a ref and set one `transform` attribute. React does not render.
- Label sizes change in steps of 1/20, and nodes are memoised on that step.
- Hover lineage toggles classes; the dimming and the edge animation are CSS.

## Reading names at any zoom

- Labels grow as the camera zooms out, up to what the node height allows.
- Below scale 0.8 secondary lines, icons and chips hide and the name takes the whole node.
- Below 0.55 table columns hide too.
- A first word shared with lane siblings is dropped: `OrganizationSync` → `…Sync`.
- Dotted and snake_case names differ at the end, so they keep their tail.

## Exploring and collapsing domains

A large repository is easier to read a few domains at a time. Any domain can be folded into a
block that keeps only its connections to what is still drawn, and unfolded again:

- on the map: the "Згорнути" control in a region's header; a double click on a block opens it;
- in the sidebar: every domain keeps its row, drawn in full or not. The row of a collapsed domain
  opens it. The icons collapse, expand, or leave only that domain. "Усі" brings everything back;
- in the detail panel of a block: "Розгорнути" and "Лише цей домен".

The last domain cannot be collapsed. After a change the camera frames the domain that was asked
for, or the whole map. Each selection has its own remembered layout, so going back to a view
shows it as it was left.

## Findings

A node with a new finding has an amber badge and a dashed edge to what it should be connected to.
A known finding has a grey badge and no edge. The panel says which consumer forgot which event and
lets you accept the finding or raise it again.

## Source

The panel ends with where the element is written. With a server behind the page the path is a
button that opens the editor at that line; next to it is a button that copies `path:line`.

## Data

On load the app asks `/api/health`. With a server it opens a WebSocket at `/ws` and draws what it
receives. Without one it runs in demo mode on the bundled fixture, and the demo button replays an
agent adding a feature through the same update path.

Without a server the browser does what the server would: it keeps the full model, collapses
domains with the same `project` function, holds the layouts of the views it has shown and its own
baseline of findings. Nothing is saved, and there is no editor to open.

UI text is Ukrainian and lives in `src/i18n.ts`.
