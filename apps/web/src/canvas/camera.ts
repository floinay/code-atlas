import type { Box } from '@code-atlas/model';

export type Camera = { x: number; y: number; k: number };
export type Bounds = { x1: number; y1: number; x2: number; y2: number };

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.4;
export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function bounds(boxes: Iterable<Box>): Bounds | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
}

/** The camera that shows `box` centred in a viewport of the given size. */
export function fit(box: Bounds, width: number, height: number): Camera {
  const k = clampZoom(Math.min((width - 48) / (box.x2 - box.x1), (height - 90) / (box.y2 - box.y1)));
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2 + 18 / k;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}

export function centreOn(x: number, y: number, k: number, width: number, height: number): Camera {
  const zoom = clampZoom(k);
  return { k: zoom, x: width / 2 - x * zoom, y: height / 2 - y * zoom };
}

/** Zooms to `k` keeping the point under the cursor fixed. */
export function zoomAt(cam: Camera, k: number, px: number, py: number): Camera {
  const zoom = clampZoom(k);
  return {
    k: zoom,
    x: px - (px - cam.x) * (zoom / cam.k),
    y: py - (py - cam.y) * (zoom / cam.k),
  };
}

export function edgePath(a: Box, b: Box): string {
  const aRight = a.x + a.w;
  const bRight = b.x + b.w;
  const ay = a.y + Math.min(a.h / 2, 30);
  const by = b.y + Math.min(b.h / 2, 30);
  if (b.x >= aRight + 10) {
    const dx = Math.max(40, (b.x - aRight) / 2);
    return `M${aRight} ${ay}C${aRight + dx} ${ay} ${b.x - dx} ${by} ${b.x} ${by}`;
  }
  if (bRight <= a.x - 10) {
    const dx = Math.max(40, (a.x - bRight) / 2);
    return `M${a.x} ${ay}C${a.x - dx} ${ay} ${bRight + dx} ${by} ${bRight} ${by}`;
  }
  const c = Math.max(aRight, bRight) + 60;
  return `M${aRight} ${ay}C${c} ${ay} ${c} ${by} ${bRight} ${by}`;
}
