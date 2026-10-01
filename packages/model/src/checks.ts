import type { Check, Model } from './schema.ts';

/**
 * Unhandled event: a consumer handles every other event of an aggregate but
 * not this one. That is almost always an event added to the aggregate without
 * updating a projection that follows it.
 *
 * It needs at least two sibling events, otherwise "handles all the others"
 * says too little to be a signal.
 */
export function runChecks(model: Pick<Model, 'elements' | 'edges'>): Check[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const eventsOf = new Map<string, string[]>();
  const consumersOf = new Map<string, Set<string>>();
  for (const edge of model.edges) {
    if (edge.kind === 'emits')
      eventsOf.set(edge.source, [...(eventsOf.get(edge.source) ?? []), edge.target]);
    if (edge.kind === 'handles') {
      const set = consumersOf.get(edge.source) ?? new Set<string>();
      set.add(edge.target);
      consumersOf.set(edge.source, set);
    }
  }
  const checks: Check[] = [];
  for (const [aggregate, events] of eventsOf) {
    if (events.length < 3) continue;
    for (const event of events) {
      const siblings = events.filter((e) => e !== event);
      const [first, ...rest] = siblings.map((e) => consumersOf.get(e) ?? new Set<string>());
      const followers = [...first!].filter((c) => rest.every((set) => set.has(c)));
      const handled = consumersOf.get(event) ?? new Set<string>();
      const missing = followers.filter((c) => !handled.has(c));
      if (!missing.length) continue;
      checks.push({
        id: `unhandled-event:${event}`,
        rule: 'unhandled-event',
        element: event,
        missing,
        detail: {
          event: byId.get(event)?.label ?? event,
          aggregate: byId.get(aggregate)?.label ?? aggregate,
          consumers: missing.map((id) => byId.get(id)?.label ?? id),
          handledSiblings: siblings.length,
        },
        known: false,
      });
    }
  }
  return checks;
}

/** One missing connection of a finding: the unit a baseline remembers. */
export const findingKeys = (check: Check): string[] => check.missing.map((missing) => `${check.element}>${missing}`);

/**
 * Marks the findings a baseline already holds as known. A finding is known
 * only when every connection it misses is in the baseline, so an old event
 * that a new projection forgets is raised again.
 */
export function applyBaseline(checks: Check[], baseline: ReadonlySet<string>): Check[] {
  return checks.map((check) => ({ ...check, known: findingKeys(check).every((key) => baseline.has(key)) }));
}

/** The baseline without what was fixed: a finding that comes back later is new again. */
export function pruneBaseline(checks: Check[], baseline: ReadonlySet<string>): Set<string> {
  const present = new Set(checks.flatMap(findingKeys));
  return new Set([...baseline].filter((key) => present.has(key)));
}
