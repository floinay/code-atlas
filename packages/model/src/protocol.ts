import type { ModelDiff } from './diff.ts';
import type { Layout } from './layout.ts';
import type { Model } from './schema.ts';

/** One line in the live feed. */
export type FeedEntry = {
  at: string;
  kind: 'info' | 'add' | 'remove' | 'change' | 'warn';
  /** What happened, as data. The web app turns it into a sentence. */
  subject:
    | { type: 'extracted'; domains: number; elements: number; edges: number; ms: number }
    | { type: 'watching'; pattern: string }
    | { type: 'element'; id: string; kind: string; label: string }
    | { type: 'edge'; source: string; target: string; kind: string }
    | { type: 'check'; event: string; aggregate: string; consumers: string[]; siblings: number }
    | { type: 'files'; count: number }
    | { type: 'error'; message: string }
    | { type: 'note'; text: string };
  file?: string;
};

/** Server → browser, over the WebSocket at `/ws`. */
export type ServerMessage =
  | {
      type: 'model';
      model: Model;
      layout: Layout;
      /** Empty on the first message, and when only the view or the baseline changed. */
      diff: ModelDiff;
      feed: FeedEntry[];
      /** Whether findings can be accepted as known: false when `checks.mode` is `all`. */
      baseline: boolean;
    }
  /** Files changed and the map did not, or the extraction failed: only the feed moves. */
  | { type: 'feed'; feed: FeedEntry[] };

/** Browser → server, over the same WebSocket. */
export type ClientMessage =
  /** Draw only these domains in full; `null` draws all of them. */
  | { type: 'explore'; domains: string[] | null }
  /** Accept a finding as known, or raise it again. */
  | { type: 'check'; id: string; known: boolean };
