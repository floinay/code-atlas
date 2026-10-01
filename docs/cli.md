# The CLI and live updates

```
code-atlas extract <repo> [--out model.json] [--only a,b] [--adapter name]
code-atlas serve <repo>   [--port 4400]      [--only a,b] [--adapter name] [--open] [--state-dir dir]
```

The CLI is TypeScript run from source through `tsx`; there is no build step for it. An adapter is
picked by looking at the repository (`--adapter` forces one).

## serve

1. Reads `.code-atlas/domains.yaml`, extracts the model, runs the checks and collapses the domains
   that are not explored.
2. Loads `.code-atlas/layout.json` if there is one and computes the layout from it, so the map
   looks the way it did last time. Saves the result.
3. Serves the built web app, plus:
   - `GET /api/health`: `{ ok, adapter, repo }`. The web app uses it to tell a server from a static host.
   - `GET /api/model`: the model.
   - `GET /api/state`: the model, the layout and the recent feed.
   - `WS /ws`: the same state on connect, then a message per change.
4. Watches the folders the adapter names (for Yeda: `features` and `libs/platform`) and the domains
   file. `node_modules`, `dist`, `.git` and other build folders inside the repository are ignored.

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

## Messages

Defined in `packages/model/src/protocol.ts`.

```ts
type ServerMessage =
  | { type: 'model'; model: Model; layout: Layout; diff: ModelDiff; feed: FeedEntry[] }
  | { type: 'feed'; feed: FeedEntry[] };
```

Feed entries are data (`{ type: 'element', kind, label }`), not sentences. The web app turns them
into Ukrainian text.

## Where state lives

| File | Written by | What |
| --- | --- | --- |
| `<repo>/.code-atlas/domains.yaml` | you | Domain overrides, explored domains, ignored checks. |
| `<repo>/.code-atlas/layout.json` | `serve` | Node and region positions. Safe to commit: it makes the map look the same for everyone. Safe to delete: the layout is computed again. |

`--state-dir` moves `layout.json` out of the repository.
