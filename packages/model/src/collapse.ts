import { elementId, type Edge, type Element, type Model } from './schema.ts';
import { edgeKey } from './view.ts';

/**
 * Keeps the listed domains in full and folds every other domain that touches
 * them into one collapsed block. Edges into a block are merged and counted,
 * so "13 role events feed this projection" stays visible as one line.
 */
export function collapseDomains(model: Model, explore: string[]): Model {
  const explored = new Set(explore);
  if (model.domains.every((d) => explored.has(d.id))) return model;
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const kept = (e: Element | undefined) => !!e && (e.domain === null || explored.has(e.domain));
  const blockId = (domain: string) => elementId(null, 'external', `domain.${domain}`);

  const blocks = new Map<string, Element>();
  const blockFor = (element: Element): string => {
    const domain = model.domains.find((d) => d.id === element.domain)!;
    const id = blockId(domain.id);
    if (!blocks.has(id))
      blocks.set(id, {
        id,
        kind: 'external',
        system: 'domain',
        domain: null,
        name: domain.name,
        label: domain.name,
        ...(domain.description ? { description: domain.description } : {}),
        evidence: { file: domain.path, line: 1 },
      });
    return id;
  };

  const merged = new Map<string, Edge & { names: string[] }>();
  const edges: Edge[] = [];
  for (const edge of model.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const keepSource = kept(source);
    const keepTarget = kept(target);
    if (keepSource && keepTarget) {
      edges.push(edge);
      continue;
    }
    if (!keepSource && !keepTarget) continue;
    const folded = {
      ...edge,
      source: keepSource ? edge.source : blockFor(source),
      target: keepTarget ? edge.target : blockFor(target),
    };
    const key = edgeKey(folded);
    const existing = merged.get(key);
    const name = (keepSource ? target : source).label;
    if (existing) {
      if (!existing.names.includes(name)) existing.names.push(name);
    } else merged.set(key, { ...folded, names: [name] });
  }
  for (const { names, ...edge } of merged.values()) {
    // Only edges leaving a block are worth counting: they say how much flows in.
    const fromBlock = blocks.has(edge.source);
    edges.push(
      fromBlock && names.length > 1 ? { ...edge, count: names.length, label: names.join(', ') } : edge,
    );
  }

  const elements = model.elements.filter(kept).map((element) =>
    element.kind === 'command' || element.kind === 'worker'
      ? { ...element, appends: element.appends.filter((id) => kept(byId.get(id))) }
      : element,
  );
  const checks = model.checks
    .filter((check) => kept(byId.get(check.element)))
    .map((check) => ({
      ...check,
      missing: [
        ...new Set(
          check.missing.flatMap((id) => {
            const element = byId.get(id);
            if (!element) return [];
            return kept(element) ? [id] : blocks.has(blockId(element.domain!)) ? [blockFor(element)] : [];
          }),
        ),
      ],
    }))
    .filter((check) => check.missing.length > 0);

  return {
    ...model,
    domains: model.domains.filter((d) => explored.has(d.id)),
    elements: [...elements, ...blocks.values()],
    edges,
    checks,
  };
}
