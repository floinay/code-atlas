import type { View, ViewEdge } from './view.ts';

export type Lineage = { nodes: Set<string>; edges: Set<string> };

const isEntry = (kind: string) => kind === 'command' || kind === 'worker';

/**
 * Everything upstream and downstream of a node:
 * entry point → state → events → projections → tables → reads and subscriptions.
 *
 * An aggregate can own many events, so walking "command → aggregate → every
 * event" would overstate what a command does. Commands and workers therefore
 * carry the exact events they append, and the walk follows those instead of
 * fanning out through the aggregate.
 */
export function lineage(view: View, start: string): Lineage {
  const nodes = new Set<string>([start]);
  const edges = new Set<string>();
  const startNode = view.byId.get(start);
  if (!startNode) return { nodes, edges };
  const real = (list: ViewEdge[] | undefined) => (list ?? []).filter((e) => !e.ghost);
  const emitterOf = (event: string) => real(view.in.get(event)).find((e) => e.kind === 'emits');

  const walk = (id: string, dir: 1 | -1, via: string | null) => {
    const node = view.byId.get(id)!;
    if (
      node.kind === 'aggregate' &&
      via &&
      ((dir === 1 && via === 'entry') || (dir === -1 && via === 'event'))
    )
      return;
    const appended = view.appends.get(id);
    for (const edge of real(dir === 1 ? view.out.get(id) : view.in.get(id))) {
      const other = dir === 1 ? edge.target : edge.source;
      if (edge.kind === 'decides' && dir === 1 && appended) continue;
      edges.add(edge.id);
      if (view.byId.get(other)!.kind === 'external' && other !== start) {
        nodes.add(other);
        continue;
      }
      if (!nodes.has(other)) {
        nodes.add(other);
        walk(other, dir, isEntry(node.kind) ? 'entry' : node.kind);
      }
    }
    if (dir === 1 && appended) {
      for (const event of appended) {
        const emits = emitterOf(event);
        if (emits) {
          const aggregate = emits.source;
          nodes.add(aggregate);
          edges.add(emits.id);
          for (const edge of real(view.out.get(id)))
            if (edge.kind === 'decides' && edge.target === aggregate) edges.add(edge.id);
          for (const edge of real(view.out.get(aggregate))) {
            if (edge.kind !== 'reads') continue;
            edges.add(edge.id);
            if (!nodes.has(edge.target)) {
              nodes.add(edge.target);
              walk(edge.target, 1, 'aggregate');
            }
          }
        }
        if (!nodes.has(event)) {
          nodes.add(event);
          walk(event, 1, 'event');
        }
      }
    }
    if (dir === -1 && node.kind === 'event') {
      const emits = emitterOf(id);
      for (const [entry, events] of view.appends) {
        if (!events.includes(id)) continue;
        if (emits)
          for (const edge of real(view.out.get(entry)))
            if (edge.kind === 'decides' && edge.target === emits.source) edges.add(edge.id);
        if (!nodes.has(entry)) {
          nodes.add(entry);
          walk(entry, -1, 'event');
        }
      }
    }
  };

  if (startNode.kind === 'external') {
    for (const edge of [...real(view.out.get(start)), ...real(view.in.get(start))]) {
      edges.add(edge.id);
      nodes.add(edge.source);
      nodes.add(edge.target);
    }
    return { nodes, edges };
  }
  walk(start, 1, null);
  if (startNode.kind === 'aggregate') {
    for (const edge of real(view.in.get(start))) {
      edges.add(edge.id);
      nodes.add(edge.source);
    }
  } else walk(start, -1, null);
  return { nodes, edges };
}

/** Splits a lineage into what the node affects and what it depends on. */
export function impact(view: View, start: string): { up: Set<string>; down: Set<string> } {
  const full = lineage(view, start);
  const down = new Set<string>();
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    const visit = (next: string) => {
      if (seen.has(next) || !full.nodes.has(next)) return;
      seen.add(next);
      down.add(next);
      queue.push(next);
    };
    for (const edge of view.out.get(id) ?? []) if (full.edges.has(edge.id)) visit(edge.target);
    for (const event of view.appends.get(id) ?? []) visit(event);
  }
  const up = new Set([...full.nodes].filter((id) => id !== start && !down.has(id)));
  return { up, down };
}
