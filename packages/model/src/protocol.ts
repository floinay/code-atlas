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
export type ServerMessage = {
  type: 'model';
  model: Model;
  layout: Layout;
  /** Empty on the first message. */
  diff: ModelDiff;
  feed: FeedEntry[];
};
