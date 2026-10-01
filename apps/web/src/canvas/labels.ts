import type { Box, TypeExpr, View, ViewNode } from '@code-atlas/model';
import { TRIGGER } from '../i18n.ts';

/** Zoom-dependent drawing state. It changes in steps, so nodes rarely re-render. */
export type Zoom = {
  /** Label scale, rounded to 1/20. Labels grow as the camera zooms out. */
  q: number;
  /** Below 0.8: secondary lines and icons hide. */
  far: boolean;
  /** Below 0.55: table columns hide too. */
  vfar: boolean;
  /** Camera scale rounded to 1/40, for region titles. */
  k: number;
};

export function zoomFor(k: number): Zoom {
  const s = Math.min(2.4, Math.max(1, 0.95 / k));
  return { q: Math.round(s * 20) / 20, far: k < 0.8, vfar: k < 0.55, k: Math.round(k * 40) / 40 };
}

/** Index after the first word of a name: `OrganizationSync` → 12, `sync.tags` → 5. */
export function firstCut(s: string): number {
  for (let i = 1; i < s.length - 1; i++) {
    if ('._-'.includes(s[i]!)) return i + 1;
    if (/[A-Z]/.test(s[i]!) && /[a-z]/.test(s[i - 1]!)) return i;
  }
  return 0;
}

/**
 * At a distance, a first word shared with lane siblings is dropped:
 * `OrganizationSync` → `…Sync`. Returns node id → shortened label.
 */
export function farLabels(view: View): Map<string, string> {
  const result = new Map<string, string>();
  const groups = new Map<string, ViewNode[]>();
  for (const node of view.nodes) {
    const key = `${node.domain}|${node.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  for (const siblings of groups.values())
    for (const node of siblings) {
      const cut = firstCut(node.label);
      if (!cut) continue;
      const prefix = node.label.slice(0, cut);
      if (siblings.some((other) => other !== node && other.label.startsWith(prefix)))
        result.set(node.id, '…' + node.label.slice(cut));
    }
  return result;
}

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
/** Width of `text` at `size` px. Falls back to an estimate where canvas is unavailable. */
export function measure(text: string, size: number, mono: boolean): number {
  const key = `${mono ? 'm' : 'u'}${size}|${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  if (context === undefined)
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  let width = text.length * size * 0.58;
  if (context) {
    context.font = mono ? `600 ${size}px "JetBrains Mono", monospace` : `600 ${size}px "Onest", system-ui, sans-serif`;
    width = context.measureText(text).width || width;
  }
  widths.set(key, width);
  return width;
}
export const resetMeasurements = () => widths.clear();

export type Label = { text: string; x: number; y: number; size: number };

/**
 * Names stay readable at every zoom: the label counter-scales as the camera
 * zooms out, takes the whole node once secondary lines are hidden, and is
 * shortened only when it still does not fit. Dotted and snake_case names
 * differ at the end, so those keep their tail.
 */
export function nodeLabel(node: ViewNode, box: Box, zoom: Zoom, farText: string | undefined): Label {
  const external = node.kind === 'external';
  const table = node.kind === 'table';
  const bundled = node.members.length > 1;
  const spec = external
    ? { x: 62, avail: box.w - 74, base: 24, cy: 48 }
    : table
      ? { x: 36, avail: box.w - 48, base: 13, cy: 24 }
      : { x: 40, avail: box.w - 40 - (bundled ? 44 : 14), base: 14, cy: 25 };
  const full = node.label;
  const maxSize = external ? 36 : table && !zoom.vfar ? 26 : (box.h - 10) * 0.62;
  const size = Math.min(spec.base * zoom.q, maxSize);
  const plain = zoom.far && !external && !table;
  const avail = plain ? box.w - 28 - (bundled ? 40 : 0) : spec.avail;
  const perChar = ((measure(full, spec.base, table) / Math.max(1, full.length)) * size) / spec.base;
  let text = full;
  if (text.length * perChar > avail && farText) text = farText;
  if (text.length * perChar > avail) {
    const keep = Math.max(3, Math.floor(avail / perChar) - 1);
    text = /[._]/.test(full)
      ? '…' + text.replace(/^…/, '').slice(-keep + 1)
      : text.slice(0, keep) + '…';
  }
  const centred = zoom.far && (!table || zoom.vfar);
  return {
    text,
    x: plain ? 14 : spec.x,
    y: centred ? box.h / 2 + size * 0.36 : table ? 19 + size * 0.36 : spec.cy,
    size,
  };
}

/** `{ a, b }` for inline objects, the type name otherwise. */
export const typeName = (expr: TypeExpr | undefined) => expr?.type ?? 'void';

/** The secondary line of a node: what goes in and what comes out. */
export function signature(node: ViewNode): string {
  const e = node.element;
  switch (e.kind) {
    case 'command':
    case 'query': {
      const fields = e.input?.fields;
      const input = fields
        ? fields.map((f) => (f.name === '…' ? '…' + f.type : f.name)).join(', ')
        : e.input && e.input.type !== '{}'
          ? e.input.type
          : '';
      return `(${input}) → ${typeName(e.responses[0]?.body)}`;
    }
    case 'aggregate':
      return `state: ${typeName(e.state)}`;
    case 'event':
      return e.payload ? typeName(e.payload) : '';
    case 'worker':
      return `⏱ ${TRIGGER[e.trigger]}`;
    case 'subscription':
      return `live · ${typeName(e.row)}`;
    default:
      return '';
  }
}
