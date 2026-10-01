# The CLI and live updates

```
code-atlas extract <repo> [--out model.json] [--only a,b] [--adapter name] [--config file]
code-atlas serve <repo>   [--port 4400]      [--only a,b] [--adapter name] [--config file]
                          [--state-dir dir]  [--editor command] [--host address] [--open]
```

The CLI is TypeScript run from source through `tsx`; there is no build step for it. An adapter is
picked by looking at the repository (`--adapter` forces one).

## serve

1. Reads `.code-atlas/domains.yaml` (or the file given with `--config`), extracts every domain in
   full and runs the checks.
2. Loads `.code-atlas/layout.json` if there is one: the layouts, the domains last explored in the
   browser and the known findings. Collapses the domains that are not explored, computes the
   layout from the saved one, so the map looks the way it did last time, and saves the result.
3. Serves the built web app, plus:
   - `GET /api/health`: `{ ok, adapter, repo }`. The web app uses it to tell a server from a static host.
   - `GET /api/model`: the model as drawn.
   - `GET /api/state`: the model, the layout and the recent feed.
   - `POST /api/open` with `{ file, line }`: opens a file of the repository in the editor.
   - `WS /ws`: the same state on connect, then a message per change. The browser sends its choices
     back over it.
4. Watches the folders the adapter names (for Yeda: `features`, `libs/platform` and the extra
   `paths` of the config) and the domains file. `node_modules`, `dist`, `.git` and other build
   folders inside the repository are ignored.

## What happens on a file change

Changes are collected for 120 ms, then:

1. The adapter forgets the changed files. Everything else stays parsed, so the next extraction
   reads only what changed from disk.
2. The model is extracted again and compared with the previous one (`diffModels`). A shifted line
   number is not a difference.
3. If nothing changed, the browser gets a feed line: "1 file changed, the map did not".
4. Otherwise the layout is computed with the previous layout as input: old nodes keep their place,
   new ones take the next free slot in their lane. The layout is saved and the browser gets the
   model, the layout, the diff and feed lines for what was added, removed or changed.
5. If the extraction throws, the last good model stays and the feed shows the error. A file saved
   halfway must not take the map down.

A change to `domains.yaml` reloads the configuration and starts from a fresh adapter.

## Which domains are drawn in full

Every domain is always extracted. Which ones are drawn in full is a view of that model, and it can
change without reading the code again:

| Who says | How | Lasts |
| --- | --- | --- |
| The browser | "Collapse", "Expand", "Only this domain", "All" | Saved in `layout.json`; the next `serve` starts with it. |
| The command line | `--only a,b` | This run. It is not saved. |
| The repository | `explore:` in `domains.yaml` | The starting point while nothing was chosen in the browser. Editing it while `serve` runs applies it and clears the browser's choice. |

Each selection is a view with its own layout (see [the model](model.md#views)).

## Checks: new findings and known ones

With `checks.mode: new` (the default) the first `serve` records every finding that is already
there as known. Known findings stay on the map as a grey badge; they draw no ghost edge and make no
line in the feed. Whatever appears later is new and is raised: a badge, a dashed edge to the
consumer that forgot the event, a warning in the feed.

- A finding is remembered per missing connection (`event>consumer`). An old event that a new
  projection forgets is therefore new.
- A finding that is fixed leaves the baseline. If it comes back, it is new again.
- In the browser a new finding can be accepted ("Це відоме") and a known one raised again.
- `checks.mode: all` raises everything on every run and keeps no baseline.
- `checks.ignore` removes a finding altogether, for an event that is unhandled on purpose.

`extract` has no state and reports every finding as new.

## Open in editor

The file path in the detail panel opens the file at its line. The server starts the editor with
[`launch-editor`](https://github.com/vitejs/launch-editor): the command from `--editor` or
`$CODE_ATLAS_EDITOR`, else the editor that is running (VS Code, Cursor, Zed, a JetBrains IDE and
others), else `$EDITOR`. The button next to the path copies `path:line`, which is what a coding
agent wants in a prompt.

## Who may talk to the server

The map shows a private repository and can start a program, so:

- it listens on `127.0.0.1` unless `--host` says otherwise;
- a request must be addressed to this machine (`Host`) and, when a browser sent it, come from a
  page this server served (`Origin`). That covers the WebSocket too, which browsers do not guard;
- `/api/open` takes only a JSON body, opens only files inside the repository, and the editor
  command never comes from the request.

## Messages

Defined in `packages/model/src/protocol.ts`.

```ts
type ServerMessage =
  | { type: 'model'; model: Model; layout: Layout; diff: ModelDiff; feed: FeedEntry[]; baseline: boolean }
  | { type: 'feed'; feed: FeedEntry[] };

type ClientMessage =
  | { type: 'explore'; domains: string[] | null }   // null: every domain
  | { type: 'check'; id: string; known: boolean };
```

A choice made in one browser tab is sent to all of them: there is one map. The answer is a `model`
message with an empty diff.

Feed entries are data (`{ type: 'element', kind, label }`), not sentences. The web app turns them
into Ukrainian text.

## Where state lives

| File | Written by | What |
| --- | --- | --- |
| `<repo>/.code-atlas/domains.yaml` | you | Domain overrides, extra paths, explored domains, checks. `--config` reads another file. |
| `<repo>/.code-atlas/layout.json` | `serve` | Node and region positions per view, the domains last explored in the browser, the known findings. Safe to commit: it makes the map look the same for everyone. Safe to delete: the layout is computed again and the findings of that moment become the new baseline. |

`--state-dir` moves `layout.json` out of the repository, and `--config` does the same for the
domains file. Together they map a repository without writing to it.

A `layout.json` written before views existed is read as the layout of the current view.
