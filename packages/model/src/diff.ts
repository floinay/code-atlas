import type { Element, Model } from './schema.ts';
import { edgeKey } from './view.ts';

export type ModelDiff = {
  addedElements: string[];
  removedElements: string[];
  changedElements: string[];
  addedEdges: string[];
  removedEdges: string[];
  addedChecks: string[];
};

/** Evidence lines shift on every edit above an element; that alone is not a change. */
const fingerprint = (element: Element) =>
  JSON.stringify({ ...element, evidence: { ...element.evidence, line: 0 } });

export function diffModels(previous: Model | undefined, next: Model): ModelDiff {
  const before = new Map((previous?.elements ?? []).map((e) => [e.id, fingerprint(e)]));
  const after = new Map(next.elements.map((e) => [e.id, fingerprint(e)]));
  const edgesBefore = new Set((previous?.edges ?? []).map(edgeKey));
  const edgesAfter = new Set(next.edges.map(edgeKey));
  const checksBefore = new Set((previous?.checks ?? []).map((c) => c.id));
  return {
    addedElements: [...after.keys()].filter((id) => !before.has(id)),
    removedElements: [...before.keys()].filter((id) => !after.has(id)),
    changedElements: [...after.keys()].filter(
      (id) => before.has(id) && before.get(id) !== after.get(id),
    ),
    addedEdges: [...edgesAfter].filter((key) => !edgesBefore.has(key)),
    removedEdges: [...edgesBefore].filter((key) => !edgesAfter.has(key)),
    addedChecks: next.checks.map((c) => c.id).filter((id) => !checksBefore.has(id)),
  };
}

export const isEmptyDiff = (diff: ModelDiff) =>
  Object.values(diff).every((list) => list.length === 0);
