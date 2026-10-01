import * as z from 'zod';
import { collapseDomains, normalizeExplore } from './collapse.ts';
import { Layout, computeLayout } from './layout.ts';
import type { Model } from './schema.ts';
import { buildView, type View } from './view.ts';

/**
 * What Code Atlas remembers between runs, in `.code-atlas/layout.json`: one
 * layout per selection of explored domains, the selection last made in the
 * UI, and the check findings that are already known.
 */
export const AtlasState = z.strictObject({
  version: z.literal(2),
  /** Domains drawn in full, as last chosen in the UI. Absent: all of them. */
  explore: z.array(z.string()).optional(),
  /** Layouts by view key, least recently used first. */
  views: z.record(z.string(), Layout).default({}),
  /** Known findings, as `event>consumer` pairs. Absent until the first run with `checks.mode: new`. */
  baseline: z.array(z.string()).optional(),
});
export type AtlasState = z.infer<typeof AtlasState>;

export const emptyState = (): AtlasState => ({ version: 2, views: {} });

/** How many views keep their layout. Older ones are laid out again when they are next opened. */
const VIEW_LIMIT = 12;

/** The key of a view: `*` for every domain, otherwise the explored ids. */
export const viewKey = (explore: readonly string[] | undefined) => (explore ? [...explore].sort().join(',') : '*');

/**
 * Reads a saved state. A version 1 file is a single layout: it becomes the
 * layout of the view named by `key`. Anything unreadable starts over rather
 * than fail.
 */
export function parseState(raw: unknown, key = '*'): AtlasState {
  const state = AtlasState.safeParse(raw);
  if (state.success) return state.data;
  const layout = Layout.safeParse(raw);
  return layout.success ? { version: 2, views: { [key]: layout.data } } : emptyState();
}

export type Projection = {
  /** The model as drawn: explored domains in full, the rest collapsed. */
  model: Model;
  view: View;
  layout: Layout;
  explore: string[] | undefined;
  /** `state` with this view's layout stored and moved to the front. */
  state: AtlasState;
};

/**
 * The map for one selection of explored domains. Each selection is a view of
 * its own with a layout that is remembered, so returning to a view shows the
 * picture that was left, and code changes never move what is already placed.
 * A view opened for the first time is packed afresh, with every region laid
 * out inside as it is in the views that already show it.
 */
export function project(full: Model, wanted: readonly string[] | null | undefined, state: AtlasState): Projection {
  const explore = normalizeExplore(wanted, full.domains);
  const model = explore ? collapseDomains(full, explore) : full;
  const view = buildView(model);
  const key = viewKey(explore);
  const { [key]: previous, ...others } = state.views;
  const layout = computeLayout(view, model.domains, previous, Object.values(others).reverse());
  const views = Object.fromEntries([...Object.entries(others), [key, layout] as const].slice(-VIEW_LIMIT));
  return { model, view, layout, explore, state: { ...state, views } };
}
