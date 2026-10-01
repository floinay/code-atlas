import type { Edge, EdgeKind, Element, ElementKind, Evidence, Model } from './schema.ts';

/** A node on the canvas: one element, or several bundled into one. */
export type ViewNode = {
  id: string;
  kind: ElementKind;
  domain: string | null;
  label: string;
  name: string;
  /** The first member. Bundled members share edges and response, so it stands for all. */
  element: Element;
  members: Element[];
  /** Set by a failed check: this node is missing an expected connection. */
  warning?: { checkIds: string[] };
};

export type ViewEdge = {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  evidence: Evidence;
  count?: number;
  label?: string;
  /** A connection that a check expected and did not find. */
  ghost?: boolean;
};

export type View = {
  nodes: ViewNode[];
  edges: ViewEdge[];
  byId: Map<string, ViewNode>;
  /** Element id → the node that shows it. */
  nodeOf: Map<string, string>;
  out: Map<string, ViewEdge[]>;
  in: Map<string, ViewEdge[]>;
  /** Command or worker node → event nodes it appends. */
  appends: Map<string, string[]>;
};

export const edgeKey = (e: { source: string; target: string; kind: string }) =>
  `${e.source}|${e.kind}|${e.target}`;

const canBundle = (e: Element) => e.kind === 'command' || e.kind === 'query';

/**
 * Elements with identical edges and an identical response collapse into one
 * node. The signature deliberately ignores the input: six lifecycle routes
 * that differ by one field still read as one thing on the map.
 */
function bundleSignature(e: Element, edges: Edge[]): string | null {
  if (!canBundle(e)) return null;
  const links = edges
    .filter((x) => x.source === e.id || x.target === e.id)
    .map((x) => (x.source === e.id ? `>${x.kind}>${x.target}` : `<${x.kind}<${x.source}`))
    .sort();
  if (links.length === 0) return null;
  const appends = e.kind === 'command' ? [...e.appends].sort() : [];
  const responses = e.responses.map((r) => [r.status, r.body.type, r.body.fields ?? null]);
  return JSON.stringify([e.domain, e.kind, links, appends, responses]);
}

export function buildView(model: Model): View {
  const groups = new Map<string, Element[]>();
  const order: (Element | string)[] = [];
  for (const element of model.elements) {
    const signature = bundleSignature(element, model.edges);
    if (!signature) {
      order.push(element);
      continue;
    }
    const group = groups.get(signature);
    if (group) group.push(element);
    else {
      groups.set(signature, [element]);
      order.push(signature);
    }
  }

  const nodes: ViewNode[] = [];
  const nodeOf = new Map<string, string>();
  for (const entry of order) {
    const members = typeof entry === 'string' ? groups.get(entry)! : [entry];
    const first = members[0]!;
    const bundled = members.length > 1;
    const id = bundled ? `bundle:${first.id}` : first.id;
    nodes.push({
      id,
      kind: first.kind,
      domain: first.domain,
      label: bundled ? `${first.label} +${members.length - 1}` : first.label,
      name: bundled ? members.map((m) => m.label).join(', ') : first.name,
      element: first,
      members,
    });
    for (const member of members) nodeOf.set(member.id, id);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: ViewEdge[] = [];
  const seen = new Map<string, ViewEdge>();
  const add = (edge: Omit<ViewEdge, 'id'>) => {
    const key = edgeKey(edge) + (edge.ghost ? '|ghost' : '');
    const existing = seen.get(key);
    if (existing) return existing;
    const created = { ...edge, id: key };
    seen.set(key, created);
    edges.push(created);
    return created;
  };
  for (const edge of model.edges) {
    const source = nodeOf.get(edge.source);
    const target = nodeOf.get(edge.target);
    if (!source || !target || source === target) continue;
    add({ ...edge, source, target });
  }
  for (const check of model.checks) {
    const source = nodeOf.get(check.element);
    if (!source) continue;
    const node = byId.get(source)!;
    node.warning = { checkIds: [...(node.warning?.checkIds ?? []), check.id] };
    for (const missing of check.missing) {
      const target = nodeOf.get(missing);
      if (target)
        add({ source, target, kind: 'handles', evidence: node.element.evidence, ghost: true });
    }
  }

  const out = new Map<string, ViewEdge[]>();
  const incoming = new Map<string, ViewEdge[]>();
  for (const node of nodes) {
    out.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    out.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }

  const appends = new Map<string, string[]>();
  for (const node of nodes) {
    const ids = new Set<string>();
    for (const member of node.members) {
      if (member.kind !== 'command' && member.kind !== 'worker') continue;
      for (const event of member.appends) {
        const eventNode = nodeOf.get(event);
        if (eventNode) ids.add(eventNode);
      }
    }
    if (ids.size) appends.set(node.id, [...ids]);
  }

  return { nodes, edges, byId, nodeOf, out, in: incoming, appends };
}

/** How many elements a node stands for. */
export const weight = (node: ViewNode) => node.members.length;
