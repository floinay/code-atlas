import { Model, type Edge, type Element } from '@code-atlas/model';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const miniRoot = fileURLToPath(new URL('./fixtures/mini', import.meta.url));

/**
 * The real Yeda monorepo, when this machine has one. Set YEDA_PATH, or put the
 * path in `.yeda-path` at the repository root. Without it the Yeda tests skip.
 */
export function yedaRoot(): string | undefined {
  const pointer = fileURLToPath(new URL('../../../.yeda-path', import.meta.url));
  const candidate = process.env.YEDA_PATH ?? (existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : undefined);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** Lookups by name, so assertions read like the map. */
export function reader(model: Model) {
  Model.parse(model);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const find = <K extends Element['kind']>(kind: K, name: string) => {
    const found = model.elements.find((e) => e.kind === kind && (e.name === name || e.label === name));
    if (!found) throw new Error(`no ${kind} named ${name}`);
    return found as Extract<Element, { kind: K }>;
  };
  const names = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).sort();
  const edges = (filter: Partial<Pick<Edge, 'source' | 'target' | 'kind'>>) =>
    model.edges.filter(
      (e) =>
        (!filter.source || e.source === filter.source) &&
        (!filter.target || e.target === filter.target) &&
        (!filter.kind || e.kind === filter.kind),
    );
  return {
    find,
    names,
    edges,
    /** Names of the elements an element points to with edges of `kind`. */
    out: (id: string, kind: Edge['kind']) => names(edges({ source: id, kind }).map((e) => e.target)),
    /** Names of the elements that point to an element with edges of `kind`. */
    into: (id: string, kind: Edge['kind']) => names(edges({ target: id, kind }).map((e) => e.source)),
    kinds: (domain: string) => {
      const counts: Record<string, number> = {};
      for (const e of model.elements) if (e.domain === domain) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      return counts;
    },
    labels: (domain: string, kind: Element['kind']) =>
      model.elements.filter((e) => e.domain === domain && e.kind === kind).map((e) => e.label).sort(),
  };
}
