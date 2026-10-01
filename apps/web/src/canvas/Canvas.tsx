import {
  GEOMETRY,
  LANES,
  laneX,
  lineage,
  weight,
  type Domain,
  type ElementKind,
  type Layout,
  type View,
} from '@code-atlas/model';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { KIND_ORDER, LANE_TITLES, count, t } from '../i18n.ts';
import { bounds, centreOn, edgePath, fit, zoomAt, type Bounds, type Camera } from './camera.ts';
import { farLabels, resetMeasurements, zoomFor, type Zoom } from './labels.ts';
import { NodeView } from './NodeView.tsx';

export type CanvasHandle = {
  fitAll(animate?: boolean): void;
  fitDomain(id: string, animate?: boolean): void;
  fitBounds(box: Bounds): void;
  focusNode(id: string, zoom?: number): void;
  zoomBy(factor: number): void;
};

type Props = {
  view: View;
  layout: Layout;
  domains: Domain[];
  hiddenKinds: Set<ElementKind>;
  newNodes: Set<string>;
  newEdges: Set<string>;
  selected: string | null;
  /** Width covered by the detail panel, so "centre" means the visible centre. */
  inset: number;
  onSelect(id: string | null): void;
  /** Overlays that live on the stage: zoom buttons, the feed, the detail panel. */
  children?: ReactNode;
};

/** Below this scale node names are too small to read, and domain names take over. */
const OVERVIEW_ZOOM = 0.2;

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(props, ref) {
  const { view, layout, domains, hiddenKinds, newNodes, newEdges, selected, inset, onSelect, children } = props;
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, k: 0.6 });
  const frame = useRef(0);
  const flight = useRef(0);
  const [zoom, setZoom] = useState<Zoom>(() => zoomFor(0.6));
  const [hovered, setHovered] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [fontEpoch, setFontEpoch] = useState(0);
  const insetRef = useRef(inset);
  insetRef.current = inset;

  const apply = useCallback(() => {
    const { x, y, k } = cam.current;
    world.current?.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    if (stage.current) {
      const size = 22 * k;
      stage.current.style.backgroundSize = `${size}px ${size}px`;
      stage.current.style.backgroundPosition = `${x}px ${y}px`;
    }
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const next = zoomFor(cam.current.k);
        setZoom((prev) =>
          prev.q === next.q && prev.far === next.far && prev.vfar === next.vfar && prev.k === next.k
            ? prev
            : next,
        );
      });
  }, []);

  const viewport = useCallback(() => {
    const el = stage.current;
    return { w: (el?.clientWidth ?? 1200) - insetRef.current, h: el?.clientHeight ?? 800 };
  }, []);

  const flyTo = useCallback(
    (target: Camera, animate = true, ms = 520) => {
      cancelAnimationFrame(flight.current);
      if (!animate || reducedMotion()) {
        cam.current = target;
        apply();
        return;
      }
      const from = { ...cam.current };
      const started = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - started) / ms);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        cam.current = {
          k: from.k + (target.k - from.k) * e,
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
        };
        apply();
        if (p < 1) flight.current = requestAnimationFrame(step);
      };
      flight.current = requestAnimationFrame(step);
    },
    [apply],
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // A fit requested while the stage has no size (a hidden tab) runs once it gets one.
  const pending = useRef<(() => void) | null>(null);
  const framed = useCallback(
    (box: Bounds | null, animate: boolean) => {
      const run = () => {
        const { w, h } = viewport();
        if (w <= 0 || h <= 0) {
          pending.current = run;
          return;
        }
        pending.current = null;
        if (box) flyTo(fit(box, w, h), animate);
      };
      run();
    },
    [flyTo, viewport],
  );
  useImperativeHandle(
    ref,
    () => ({
      fitAll(animate = true) {
        const l = layoutRef.current;
        framed(bounds([...Object.values(l.regions), ...Object.values(l.nodes)]), animate);
      },
      fitDomain(id, animate = true) {
        const r = layoutRef.current.regions[id];
        if (r) framed({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h }, animate);
      },
      fitBounds(box) {
        framed(box, true);
      },
      focusNode(id, k) {
        const b = layoutRef.current.nodes[id];
        const { w, h } = viewport();
        if (b) flyTo(centreOn(b.x + b.w / 2, b.y + b.h / 2, k ?? Math.max(cam.current.k, 0.95), w, h));
      },
      zoomBy(factor) {
        const { w, h } = viewport();
        cam.current = zoomAt(cam.current, cam.current.k * factor, w / 2, h / 2);
        apply();
      },
    }),
    [apply, flyTo, framed, viewport],
  );

  useLayoutEffect(() => {
    apply();
  }, [apply]);
  useEffect(() => {
    const onResize = () => apply();
    addEventListener('resize', onResize);
    const observer = new ResizeObserver(() => pending.current?.());
    if (stage.current) observer.observe(stage.current);
    void document.fonts?.ready.then(() => {
      resetMeasurements();
      setFontEpoch((n) => n + 1);
    });
    return () => {
      removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [apply]);

  // Wheel zoom needs a non-passive listener, which React does not attach.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      cancelAnimationFrame(flight.current);
      const r = stage.current!.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016));
      cam.current = zoomAt(cam.current, cam.current.k * factor, ev.clientX - r.left, ev.clientY - r.top);
      apply();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply]);

  // Pointer: pan with one pointer, pinch with two, click when it barely moved.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ x: number; y: number; cx: number; cy: number; target: string | null } | null>(null);
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const moved = useRef(0);
  const nodeAt = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.('.node')?.getAttribute('data-id') ?? null;

  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    cancelAnimationFrame(flight.current);
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved.current = 0;
    if (pointers.current.size === 1)
      pan.current = { x: ev.clientX, y: ev.clientY, cx: cam.current.x, cy: cam.current.y, target: nodeAt(ev.target) };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.current.k };
    }
  };
  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(ev.pointerId)) return;
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const r = stage.current!.getBoundingClientRect();
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const k = (pinch.current.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d;
      cam.current = zoomAt(cam.current, k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      apply();
      moved.current = 99;
      return;
    }
    if (!pan.current) return;
    const dx = ev.clientX - pan.current.x;
    const dy = ev.clientY - pan.current.y;
    moved.current = Math.max(moved.current, Math.hypot(dx, dy));
    if (moved.current > 4) {
      setPanning(true);
      cam.current = { ...cam.current, x: pan.current.cx + dx, y: pan.current.cy + dy };
      apply();
    }
  };
  const onPointerEnd = (ev: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(ev.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      setPanning(false);
      if (pan.current && moved.current <= 4) onSelect(pan.current.target);
      pan.current = null;
    }
  };

  const focusId = hovered && view.byId.has(hovered) ? hovered : selected && view.byId.has(selected) ? selected : null;
  const focus = useMemo(() => (focusId ? lineage(view, focusId) : null), [view, focusId]);
  const far = useMemo(() => farLabels(view), [view]);
  // Nodes only depend on the label step, not on every camera scale.
  const nodeZoom = useMemo<Zoom>(
    () => ({ q: zoom.q, far: zoom.far, vfar: zoom.vfar, k: 0 }),
    [zoom.q, zoom.far, zoom.vfar],
  );
  const visible = (kind: ElementKind) => !hiddenKinds.has(kind);

  const regions = domains.flatMap((domain) => {
    const r = layout.regions[domain.id];
    if (!r) return [];
    const counts = new Map<ElementKind, number>();
    for (const node of view.nodes)
      if (node.domain === domain.id) counts.set(node.kind, (counts.get(node.kind) ?? 0) + weight(node));
    const k = Math.max(zoom.k, 0.05);
    // From far away a domain reads like a country on a map: one big name across it.
    const overview = zoom.k < OVERVIEW_ZOOM;
    const titleSize = Math.min(64, 26 * Math.max(1, 0.75 / k));
    const laneSize = Math.min(30, 11 * Math.max(1, 0.8 / k));
    const x0 = r.x + GEOMETRY.pad;
    return [
      <g className="region" key={domain.id}>
        <rect className="rbg" x={r.x} y={r.y} width={r.w} height={r.h} rx={18} />
        {!overview && (
          <text className="rtitle" x={r.x + 24} y={r.y + Math.max(40, titleSize * 0.9 + 6)} style={{ fontSize: titleSize }}>
            {domain.name}
          </text>
        )}
        <text className="rmeta" x={r.x + 24} y={r.y + 62}>
          {domain.path}
          {'   ·   '}
          {KIND_ORDER.filter((kind) => counts.get(kind)).map((kind) => count(counts.get(kind)!, kind)).join(' · ')}
        </text>
        {LANES.map((kind, i) => (
          <g key={kind}>
            <text
              className="lane"
              x={x0 + laneX(i)}
              y={r.y + Math.max(90, 76 + laneSize * 1.1)}
              style={{ fontSize: laneSize, display: zoom.k < 0.34 ? 'none' : undefined }}
            >
              {LANE_TITLES[i]}
            </text>
            {i > 0 && (
              <line className="lanerule" x1={x0 + laneX(i) - 18} x2={x0 + laneX(i) - 18} y1={r.y + 76} y2={r.y + r.h - 16} />
            )}
          </g>
        ))}
      </g>,
    ];
  });

  return (
    <div className="stage" ref={stage}>
      <svg
        ref={svg}
        className={['cv', zoom.far && 'far', zoom.vfar && 'vfar', focus && 'focus', panning && 'panning'].filter(Boolean).join(' ')}
        role="img"
        aria-label={t.map}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerOver={(ev) => {
          if (ev.pointerType === 'touch' || pointers.current.size) return;
          const id = nodeAt(ev.target);
          setHovered((prev) => (prev === id ? prev : id));
        }}
        onPointerLeave={() => setHovered(null)}
        onKeyDown={(ev) => {
          const id = nodeAt(ev.target);
          if (id && (ev.key === 'Enter' || ev.key === ' ')) {
            ev.preventDefault();
            onSelect(id);
          }
        }}
        onFocus={(ev) => {
          const id = nodeAt(ev.target);
          if (id) setHovered(id);
        }}
        onBlur={() => setHovered(null)}
      >
        <defs>
          <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="arrow" d="M0 0.8L7 4L0 7.2z" />
          </marker>
        </defs>
        <g ref={world}>
          <g>{regions}</g>
          <g>
            {view.edges.map((edge) => {
              const a = view.byId.get(edge.source)!;
              const b = view.byId.get(edge.target)!;
              const from = layout.nodes[edge.source];
              const to = layout.nodes[edge.target];
              if (!from || !to || !visible(a.kind) || !visible(b.kind)) return null;
              const className = [
                'edge',
                `r-${edge.kind}`,
                (a.domain ?? 'x') !== (b.domain ?? 'y') && 'cross',
                edge.ghost && 'ghost',
                newEdges.has(edge.id) && 'new',
                focus?.edges.has(edge.id) && 'hl',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <path
                  key={edge.id}
                  className={className}
                  d={edgePath(from, to)}
                  markerEnd="url(#arr)"
                  style={{ '--k': `var(--${a.kind})` } as CSSProperties}
                />
              );
            })}
          </g>
          <g>
            {view.nodes.map((node) => {
              const box = layout.nodes[node.id];
              if (!box || !visible(node.kind)) return null;
              return (
                <NodeView
                  key={node.id}
                  node={node}
                  box={box}
                  zoom={nodeZoom}
                  farText={far.get(node.id)}
                  isNew={newNodes.has(node.id)}
                  selected={selected === node.id}
                  highlighted={!!focus?.nodes.has(node.id)}
                  fontEpoch={fontEpoch}
                />
              );
            })}
          </g>
          {zoom.k < OVERVIEW_ZOOM && (
            <g className="overview">
              {domains.map((domain) => {
                const r = layout.regions[domain.id];
                if (!r) return null;
                const size = Math.min(26 / Math.max(zoom.k, 0.05), r.h * 0.42, (r.w * 1.5) / Math.max(4, domain.name.length));
                return (
                  <text
                    key={domain.id}
                    x={r.x + r.w / 2}
                    y={r.y + r.h / 2 + size * 0.35}
                    textAnchor="middle"
                    style={{ fontSize: size, strokeWidth: size * 0.16 }}
                  >
                    {domain.name}
                  </text>
                );
              })}
            </g>
          )}
        </g>
      </svg>
      {children}
    </div>
  );
});
