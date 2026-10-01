import * as z from 'zod';
import { LANES, type Domain, type LaneKind } from './schema.ts';
import type { View, ViewNode } from './view.ts';

/** Geometry of the map. The web app draws with the same numbers. */
export const GEOMETRY = {
  laneWidth: 286,
  nodeWidth: 250,
  tableWidth: 262,
  nodeHeight: 60,
  gap: 14,
  head: 104,
  pad: 36,
  regionGapY: 170,
  regionGapX: 260,
  minRegionGap: 60,
  externalWidth: 270,
  externalHeight: 100,
  externalOffset: 170,
  tableHead: 40,
  tableRow: 21,
} as const;

const G = GEOMETRY;
export const laneX = (lane: number) => lane * G.laneWidth;
export const REGION_WIDTH = laneX(LANES.length - 1) + G.nodeWidth + G.pad * 2;

export const Box = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof Box>;

/** Persisted to `.code-atlas/layout.json` so the map looks the same tomorrow. */
export const Layout = z.strictObject({
  version: z.literal(1),
  columns: z.int().positive(),
  regions: z.record(z.string(), Box.extend({ column: z.int().nonnegative() })),
  nodes: z.record(z.string(), Box),
});
export type Layout = z.infer<typeof Layout>;

export const laneOf = (node: ViewNode) => LANES.indexOf(node.kind as LaneKind);

export function heightOf(node: ViewNode): number {
  if (node.kind === 'external') return G.externalHeight;
  if (node.element.kind === 'table')
    return G.tableHead + node.element.columns.length * G.tableRow + 8;
  return G.nodeHeight;
}
const widthOf = (node: ViewNode) =>
  node.kind === 'external' ? G.externalWidth : node.kind === 'table' ? G.tableWidth : G.nodeWidth;

const columnX = (column: number) => column * (REGION_WIDTH + G.regionGapX) - G.pad;

/**
 * Places every node. With no previous layout, lanes are packed and centred.
 * With one, existing nodes keep their place: a new node takes the next free
 * slot in its lane, and a region only moves when the one above outgrows the
 * space between them.
 *
 * `templates` are layouts of other views of the same model. A region that is
 * new here but drawn there is laid out inside the same way, so a domain looks
 * the same in every view even though it sits somewhere else.
 */
export function computeLayout(view: View, domains: Domain[], previous?: Layout, templates: Layout[] = []): Layout {
  const next: Layout = {
    version: 1,
    columns: previous?.columns ?? chooseColumns(view, domains),
    regions: {},
    nodes: {},
  };
  const columnBottom = (column: number) =>
    Math.max(
      -G.regionGapY,
      ...Object.values(next.regions)
        .filter((r) => r.column === column)
        .map((r) => r.y + r.h),
    );

  // Regions that already exist keep their origin, so they are placed first.
  const ordered = [
    ...domains.filter((d) => previous?.regions[d.id]),
    ...domains.filter((d) => !previous?.regions[d.id]),
  ];
  for (const domain of ordered) {
    const members = view.nodes.filter((n) => n.domain === domain.id && laneOf(n) >= 0);
    let known = previous?.regions[domain.id];
    let placed: Record<string, Box> | undefined = previous?.nodes;
    let column = 0;
    let x = 0;
    let y = 0;
    if (!known) {
      for (let c = 1; c < next.columns; c++) if (columnBottom(c) < columnBottom(column)) column = c;
      y = columnBottom(column) + G.regionGapY;
      x = columnX(column);
      const template = templates.find((t) => t.regions[domain.id]);
      if (template) {
        const source = template.regions[domain.id]!;
        const dx = x - source.x;
        const dy = y - source.y;
        known = { ...source, x, y, column };
        placed = {};
        for (const node of members) {
          const box = template.nodes[node.id];
          if (box) placed[node.id] = { ...box, x: box.x + dx, y: box.y + dy };
        }
      }
    }
    if (known) {
      const region = { ...known };
      next.regions[domain.id] = region;
      const lanes = LANES.map(() => [] as { node: ViewNode; box: Box }[]);
      const fresh: ViewNode[] = [];
      for (const node of members) {
        const old = placed?.[node.id];
        if (!old) {
          fresh.push(node);
          continue;
        }
        lanes[laneOf(node)]!.push({ node, box: { ...old, h: heightOf(node) } });
      }
      for (const lane of lanes) {
        lane.sort((a, b) => a.box.y - b.box.y);
        // A node that grew (a table gained a column) pushes its lane down.
        for (let i = 1; i < lane.length; i++) {
          const above = lane[i - 1]!.box;
          const box = lane[i]!.box;
          if (box.y < above.y + above.h + G.gap) box.y = above.y + above.h + G.gap;
        }
      }
      for (const node of fresh) {
        const lane = lanes[laneOf(node)]!;
        const h = heightOf(node);
        // The next free slot: a hole left by a removed node, else below the last one.
        let slot = lane.length ? lane[0]!.box.y + lane[0]!.box.h + G.gap : region.y + G.head;
        for (const { box } of lane.slice(1)) {
          if (box.y - slot >= h + G.gap) break;
          slot = box.y + box.h + G.gap;
        }
        lane.push({ node, box: { x: laneX(laneOf(node)) + region.x + G.pad, y: slot, w: widthOf(node), h } });
        lane.sort((a, b) => a.box.y - b.box.y);
      }
      let bottom = region.y + G.head + G.nodeHeight;
      for (const lane of lanes)
        for (const { node, box } of lane) {
          next.nodes[node.id] = box;
          bottom = Math.max(bottom, box.y + box.h);
        }
      region.h = Math.max(region.h, bottom - region.y + G.pad);
    } else {
      const lanes = LANES.map(() => [] as ViewNode[]);
      for (const node of members) lanes[laneOf(node)]!.push(node);
      const laneHeights = lanes.map(
        (lane) => lane.reduce((sum, n) => sum + heightOf(n), 0) + Math.max(0, lane.length - 1) * G.gap,
      );
      const tallest = Math.max(G.nodeHeight, ...laneHeights);
      lanes.forEach((lane, index) => {
        let cy = y + G.head + (tallest - laneHeights[index]!) / 2;
        for (const node of lane) {
          const h = heightOf(node);
          next.nodes[node.id] = { x: x + G.pad + laneX(index), y: cy, w: widthOf(node), h };
          cy += h + G.gap;
        }
      });
      next.regions[domain.id] = { x, y, w: REGION_WIDTH, h: G.head + tallest + G.pad, column };
    }
  }

  // A region that outgrew the gap below it pushes the rest of its column down.
  for (let column = 0; column < next.columns; column++) {
    const stack = Object.entries(next.regions)
      .filter(([, r]) => r.column === column)
      .sort(([, a], [, b]) => a.y - b.y);
    for (let i = 1; i < stack.length; i++) {
      const above = stack[i - 1]![1];
      const [id, region] = stack[i]!;
      const shift = above.y + above.h + G.minRegionGap - region.y;
      if (shift <= 0) continue;
      region.y += shift;
      for (const node of view.nodes)
        if (node.domain === id && next.nodes[node.id]) next.nodes[node.id]!.y += shift;
    }
  }

  placeExternals(view, next, previous);
  return next;
}

/** The height a region needs: its tallest lane plus the header. */
function regionHeight(view: View, domain: string): number {
  const lanes = LANES.map(() => 0);
  const counts = LANES.map(() => 0);
  for (const node of view.nodes) {
    if (node.domain !== domain || laneOf(node) < 0) continue;
    lanes[laneOf(node)]! += heightOf(node);
    counts[laneOf(node)]!++;
  }
  const tallest = Math.max(G.nodeHeight, ...lanes.map((h, i) => h + Math.max(0, counts[i]! - 1) * G.gap));
  return G.head + tallest + G.pad;
}

/**
 * Regions are wide, so a few small domains read best stacked in one column
 * and many tall ones need several. Picks the column count whose overall shape
 * is closest to a screen.
 */
function chooseColumns(view: View, domains: Domain[]): number {
  const heights = domains.map((d) => regionHeight(view, d.id));
  let best = 1;
  let bestScore = Infinity;
  for (let columns = 1; columns <= Math.min(4, Math.max(1, domains.length)); columns++) {
    const stacks = Array.from({ length: columns }, () => 0);
    for (const h of heights) {
      const shortest = stacks.indexOf(Math.min(...stacks));
      stacks[shortest] = stacks[shortest]! + h + (stacks[shortest] ? G.regionGapY : 0);
    }
    const width = columns * REGION_WIDTH + (columns - 1) * G.regionGapX;
    const score = Math.abs(Math.log(width / Math.max(...stacks) / 1.6));
    if (score < bestScore) {
      best = columns;
      bestScore = score;
    }
  }
  return best;
}

/** External systems sit left of the map, collapsed domains right of it. */
function placeExternals(view: View, layout: Layout, previous?: Layout) {
  const externals = view.nodes.filter((n) => n.kind === 'external');
  if (!externals.length) return;
  const regions = Object.values(layout.regions);
  const left = Math.min(0, ...regions.map((r) => r.x)) - G.externalWidth - G.externalOffset;
  const right = Math.max(0, ...regions.map((r) => r.x + r.w)) + G.externalOffset;
  const placed: Box[] = [];
  const pending: ViewNode[] = [];
  for (const node of externals) {
    const old = previous?.nodes[node.id];
    if (old) {
      layout.nodes[node.id] = { ...old };
      placed.push(layout.nodes[node.id]!);
    } else pending.push(node);
  }
  for (const node of pending) {
    const isDomain = node.element.kind === 'external' && node.element.system === 'domain';
    const x = isDomain ? right : left;
    const linked = [...(view.out.get(node.id) ?? []), ...(view.in.get(node.id) ?? [])]
      .map((e) => layout.nodes[e.source === node.id ? e.target : e.source])
      .filter((b): b is Box => !!b);
    let y = linked.length
      ? linked.reduce((sum, b) => sum + b.y + b.h / 2, 0) / linked.length - G.externalHeight / 2
      : 0;
    const clashes = () =>
      placed.some((b) => b.x === x && Math.abs(b.y - y) < G.externalHeight + 40);
    while (clashes()) y += G.externalHeight + 40;
    const box = { x, y, w: G.externalWidth, h: G.externalHeight };
    layout.nodes[node.id] = box;
    placed.push(box);
  }
}

/** Node ids present in `layout` but not in `previous`: the ones to badge as new. */
export function addedNodes(layout: Layout, previous?: Layout): string[] {
  if (!previous) return [];
  return Object.keys(layout.nodes).filter((id) => !previous.nodes[id]);
}
