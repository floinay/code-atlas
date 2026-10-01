import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Model,
  buildView,
  collapseDomains,
  computeLayout,
  addedNodes,
  applyBaseline,
  diffModels,
  domainBlockId,
  emptyState,
  findingKeys,
  normalizeExplore,
  parseState,
  project,
  pruneBaseline,
  impact,
  lineage,
  runChecks,
  weight,
  type Element,
} from '../src/index.ts';

const fixture = Model.parse(
  JSON.parse(readFileSync(new URL('../fixtures/prototype.model.json', import.meta.url), 'utf8')),
);
const id = (name: string) => fixture.elements.find((e) => e.name === name)!.id;

describe('fixture', () => {
  it('matches the prototype: 71 elements, 3 neighbours', () => {
    expect(fixture.elements.filter((e) => e.kind !== 'external')).toHaveLength(71);
    expect(fixture.elements.filter((e) => e.kind === 'external')).toHaveLength(3);
  });
  it('gives every element and edge evidence', () => {
    for (const item of [...fixture.elements, ...fixture.edges]) {
      expect(item.evidence.file).not.toBe('');
      expect(item.evidence.line).toBeGreaterThan(0);
    }
  });
  it('only links elements that exist', () => {
    const ids = new Set(fixture.elements.map((e) => e.id));
    for (const edge of fixture.edges) {
      expect(ids.has(edge.source), edge.source).toBe(true);
      expect(ids.has(edge.target), edge.target).toBe(true);
    }
  });
});

describe('buildView', () => {
  const view = buildView(fixture);
  it('bundles routes with identical edges and response: 68 nodes, 112 edges', () => {
    expect(view.nodes).toHaveLength(68);
    expect(view.edges).toHaveLength(112);
    expect(view.nodes.reduce((sum, n) => sum + (n.kind === 'external' ? 0 : weight(n)), 0)).toBe(71);
  });
  it('folds the six lifecycle and logo commands into one node', () => {
    const bundle = view.byId.get(view.nodeOf.get(id('organizations.suspend'))!)!;
    expect(bundle.members.map((m) => m.name).sort()).toEqual([
      'organizations.archive',
      'organizations.logo.publish',
      'organizations.logo.remove',
      'organizations.resume',
      'organizations.suspend',
      'organizations.unarchive',
    ]);
    expect(bundle.label).toBe('suspend +5');
  });
  it('keeps commands with a different response apart', () => {
    expect(view.nodeOf.get(id('organizations.update'))).toBe(id('organizations.update'));
  });
});

describe('lineage', () => {
  const view = buildView(fixture);
  const names = (ids: Set<string>) =>
    [...ids].map((n) => view.byId.get(n)!.label).sort();
  it('follows a command through exactly the events it appends', () => {
    const { nodes } = lineage(view, id('tags.create'));
    const labels = names(nodes);
    expect(labels).toContain('tag-created');
    expect(labels).not.toContain('tag-deleted');
    expect(labels).toContain('Tags');
    expect(labels).toContain('definitions');
    expect(labels).toContain('sync.tags');
    expect(labels).toContain('TagCatalog');
  });
  it('walks an event back to the commands that append it', () => {
    const { nodes } = lineage(view, id('tags.tag-deleted'));
    const labels = names(nodes);
    expect(labels).toContain('delete');
    expect(labels).not.toContain('create');
    expect(labels).toContain('Entity tags');
  });
  it('splits impact into upstream and downstream', () => {
    const { up, down } = impact(view, id('tags.tag-created'));
    expect(names(up)).toEqual(['TagCatalog', 'create']);
    expect(names(down)).toContain('definitions');
  });
});

describe('computeLayout', () => {
  const view = buildView(fixture);
  const first = computeLayout(view, fixture.domains);
  it('places every node without overlap inside a lane', () => {
    for (const node of view.nodes) expect(first.nodes[node.id], node.id).toBeDefined();
    const boxes = view.nodes
      .filter((n) => n.domain === 'tags')
      .map((n) => first.nodes[n.id]!);
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b && a.x === b.x) expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });
  it('is stable: a new element takes a free slot and nothing else moves', () => {
    const added: Element = {
      id: 'tags:event:tags.tags-merged',
      kind: 'event',
      domain: 'tags',
      name: 'tags.tags-merged',
      label: 'tags-merged',
      evidence: { file: 'features/tags/contracts/src/lib/tags-contracts.ts', line: 580 },
    };
    const next = Model.parse({ ...fixture, elements: [...fixture.elements, added] });
    const second = computeLayout(buildView(next), next.domains, first);
    for (const [node, box] of Object.entries(first.nodes)) expect(second.nodes[node]).toEqual(box);
    expect(addedNodes(second, first)).toEqual([added.id]);
    const events = view.nodes.filter((n) => n.domain === 'tags' && n.kind === 'event');
    const bottom = Math.max(...events.map((n) => first.nodes[n.id]!.y + first.nodes[n.id]!.h));
    expect(second.nodes[added.id]!.y).toBeGreaterThan(bottom);
    expect(second.nodes[added.id]!.x).toBe(first.nodes[events[0]!.id]!.x);
  });
  it('reuses the slot of a removed element', () => {
    const victim = id('tags.tag-updated');
    const without = Model.parse({
      ...fixture,
      elements: fixture.elements.filter((e) => e.id !== victim),
      edges: fixture.edges.filter((e) => e.source !== victim && e.target !== victim),
    });
    const second = computeLayout(buildView(without), without.domains, first);
    expect(second.nodes[victim]).toBeUndefined();
    const third = computeLayout(view, fixture.domains, second);
    expect(third.nodes[victim]).toEqual(first.nodes[victim]);
  });
});

describe('runChecks', () => {
  it('finds nothing in the fixture', () => {
    expect(runChecks(fixture)).toEqual([]);
  });
  it('warns when a consumer follows every other event of an aggregate', () => {
    const merged: Element = {
      id: 'tags:event:tags.tags-merged',
      kind: 'event',
      domain: 'tags',
      name: 'tags.tags-merged',
      label: 'tags-merged',
      evidence: { file: 'features/tags/contracts/src/lib/tags-contracts.ts', line: 580 },
    };
    const evidence = merged.evidence;
    const next = {
      elements: [...fixture.elements, merged],
      edges: [
        ...fixture.edges,
        { source: id('TagCatalog'), target: merged.id, kind: 'emits' as const, evidence },
        { source: merged.id, target: id('organizations.activity'), kind: 'handles' as const, evidence },
      ],
    };
    const checks = runChecks(next);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.element).toBe(merged.id);
    expect(checks[0]!.detail.consumers.sort()).toEqual(['Actors', 'Auth']);
  });
});

describe('diffModels', () => {
  it('ignores evidence line shifts', () => {
    const shifted = {
      ...fixture,
      elements: fixture.elements.map((e) => ({ ...e, evidence: { ...e.evidence, line: e.evidence.line + 3 } })),
    } as Model;
    const diff = diffModels(fixture, shifted);
    expect(diff.changedElements).toEqual([]);
    expect(diff.addedElements).toEqual([]);
  });
});

describe('collapseDomains', () => {
  it('folds an unexplored domain into one block with counted edges', () => {
    const collapsed = collapseDomains(fixture, ['organizations']);
    expect(collapsed.domains.map((d) => d.id)).toEqual(['organizations']);
    const block = collapsed.elements.find((e) => e.name === 'Tags' && e.kind === 'external')!;
    expect(block).toBeDefined();
    const incoming = collapsed.edges.filter(
      (e) => e.source === block.id && e.target === id('organizations.activity'),
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.count).toBe(6);
    expect(collapsed.elements.some((e) => e.domain === 'tags')).toBe(false);
  });
});

describe('explore', () => {
  it('lists what it folded away, with or without a block', () => {
    const collapsed = collapseDomains(fixture, ['organizations']);
    expect(collapsed.collapsed.map((d) => d.id)).toEqual(['tags']);
    expect(collapsed.elements.some((e) => e.id === domainBlockId('tags'))).toBe(true);
    expect(collapseDomains(fixture, ['organizations', 'tags']).collapsed).toEqual([]);
  });

  it('cleans a selection: unknown ids go, all or nothing means no selection', () => {
    const domains = fixture.domains;
    expect(normalizeExplore(['tags', 'nope'], domains)).toEqual(['tags']);
    expect(normalizeExplore(['tags', 'organizations'], domains)).toBeUndefined();
    expect(normalizeExplore([], domains)).toBeUndefined();
    expect(normalizeExplore(null, domains)).toBeUndefined();
  });

  it('keeps one layout per view and returns to it unchanged', () => {
    const all = project(fixture, undefined, emptyState());
    const focused = project(fixture, ['tags'], all.state);
    expect(focused.model.domains.map((d) => d.id)).toEqual(['tags']);
    expect(Object.keys(focused.state.views)).toEqual(['*', 'tags']);
    const back = project(fixture, null, focused.state);
    expect(back.layout).toEqual(all.layout);
    // The view that was just used is the last to be forgotten.
    expect(Object.keys(back.state.views)).toEqual(['tags', '*']);
    expect(project(fixture, ['tags'], back.state).layout).toEqual(focused.layout);
  });

  it('lays a region out inside the same way in every view', () => {
    const all = project(fixture, undefined, emptyState());
    // The full view has lived a little: one node sits lower than a fresh layout would put it.
    const moved = all.view.nodes.find((n) => n.domain === 'tags' && n.kind === 'event')!.id;
    const lived = structuredClone(all.state);
    lived.views['*']!.nodes[moved]!.y += 500;
    lived.views['*']!.regions['tags']!.h += 500;
    const focused = project(fixture, ['tags'], lived);
    const from = lived.views['*']!;
    const to = focused.layout;
    const dx = to.regions['tags']!.x - from.regions['tags']!.x;
    const dy = to.regions['tags']!.y - from.regions['tags']!.y;
    expect(to.regions['tags']!.y).toBe(0);
    for (const node of focused.view.nodes.filter((n) => n.domain === 'tags')) {
      const box = from.nodes[node.id];
      if (box) expect(to.nodes[node.id], node.id).toEqual({ ...box, x: box.x + dx, y: box.y + dy });
    }
    expect(to.nodes[moved]!.y - to.regions['tags']!.y).toBe(from.nodes[moved]!.y - from.regions['tags']!.y);
  });

  it('reads a version 1 layout file as the layout of the current view', () => {
    const layout = computeLayout(buildView(fixture), fixture.domains);
    expect(parseState(layout, 'tags').views).toEqual({ tags: layout });
    expect(parseState('nonsense')).toEqual(emptyState());
    const state = { version: 2, explore: ['tags'], views: { '*': layout }, baseline: ['a>b'] };
    expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe('baseline', () => {
  const merged: Element = {
    id: 'tags:event:tags.tags-merged',
    kind: 'event',
    domain: 'tags',
    name: 'tags.tags-merged',
    label: 'tags-merged',
    evidence: { file: 'features/tags/contracts/src/lib/tags-contracts.ts', line: 580 },
  };
  const broken: Model = {
    ...fixture,
    elements: [...fixture.elements, merged],
    edges: [
      ...fixture.edges,
      { source: id('TagCatalog'), target: merged.id, kind: 'emits', evidence: merged.evidence },
      { source: merged.id, target: id('organizations.activity'), kind: 'handles', evidence: merged.evidence },
    ],
  };
  const checks = runChecks(broken);
  const keys = checks.flatMap(findingKeys);

  it('remembers a finding by each connection it misses', () => {
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.startsWith(`${merged.id}>`))).toBe(true);
  });

  it('knows a finding only when all of it is in the baseline', () => {
    expect(applyBaseline(checks, new Set(keys))[0]!.known).toBe(true);
    expect(applyBaseline(checks, new Set(keys.slice(0, 1)))[0]!.known).toBe(false);
    expect(applyBaseline(checks, new Set())[0]!.known).toBe(false);
  });

  it('forgets what was fixed', () => {
    expect([...pruneBaseline(checks, new Set([...keys, 'gone>fixed']))].sort()).toEqual([...keys].sort());
    expect(pruneBaseline([], new Set(keys)).size).toBe(0);
  });

  it('draws a known finding quietly: a badge, no ghost edge, no news', () => {
    const loud = { ...broken, checks };
    const quiet = { ...broken, checks: applyBaseline(checks, new Set(keys)) };
    const node = (model: Model) => buildView(model).byId.get(merged.id)!;
    expect(node(loud).warning).toEqual({ checkIds: [checks[0]!.id], known: false });
    expect(node(quiet).warning).toEqual({ checkIds: [checks[0]!.id], known: true });
    expect(buildView(loud).edges.filter((e) => e.ghost)).toHaveLength(2);
    expect(buildView(quiet).edges.filter((e) => e.ghost)).toHaveLength(0);
    expect(diffModels(fixture, loud).addedChecks).toEqual([checks[0]!.id]);
    expect(diffModels(fixture, quiet).addedChecks).toEqual([]);
    // Raising a known finding again is news.
    expect(diffModels(quiet, loud).addedChecks).toEqual([checks[0]!.id]);
  });
});
