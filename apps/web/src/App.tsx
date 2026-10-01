import { GEOMETRY, laneX, type ElementKind } from '@code-atlas/model';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, type CanvasHandle } from './canvas/Canvas.tsx';
import { Feed } from './chrome/Feed.tsx';
import { Search } from './chrome/Search.tsx';
import { Sidebar } from './chrome/Sidebar.tsx';
import { demoIntro, demoReset, demoSteps, demoWarning } from './demo.ts';
import { t } from './i18n.ts';
import { Panel } from './panel/Panel.tsx';
import { fixtureModel, useAtlas } from './state.ts';

type Theme = 'dark' | 'light';
const THEME_KEY = 'code-atlas.theme';
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () =>
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  return { theme, toggle };
}

export function App() {
  const { atlas, applyLocal, log, clearNew } = useAtlas();
  const { model, view, layout } = atlas;
  const canvas = useRef<CanvasHandle>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<ElementKind>>(new Set());
  const [sideOpen, setSideOpen] = useState(false);
  const [demo, setDemo] = useState<'idle' | 'running' | 'done'>('idle');
  const { theme, toggle } = useTheme();
  const narrow = () => innerWidth <= 900;
  const selectedNode = selected ? view.byId.get(selected) : undefined;

  // The first model, and any wholesale replacement, frames the map.
  useEffect(() => {
    if (atlas.epoch === 0) return;
    const first = model.domains[0];
    if (model.domains.length <= 2 && first) canvas.current?.fitDomain(first.id, false);
    else canvas.current?.fitAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas.epoch]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (ev.key === 'Escape' && !typing) setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (id) clearNew([id]);
    },
    [clearNew],
  );
  const go = useCallback(
    (id: string, zoom?: number) => {
      select(id);
      // Wait for the panel to open, so the node is centred in what stays visible.
      requestAnimationFrame(() => canvas.current?.focusNode(id, zoom));
    },
    [select],
  );

  const runDemo = async () => {
    setDemo('running');
    select(null);
    const base = fixtureModel();
    const region = layout.regions['tags'];
    if (region)
      canvas.current?.fitBounds({
        x1: laneX(1) - 20,
        x2: laneX(5) + GEOMETRY.nodeWidth + 20,
        y1: region.y,
        y2: region.y + region.h + 90,
      });
    log(demoIntro());
    for (const step of demoSteps(base)) {
      await sleep(1250);
      applyLocal(step.model, [step.feed]);
      if (step.select) {
        await sleep(1250);
        log(demoWarning());
        setSelected(step.select);
      }
    }
    setDemo('done');
  };
  const resetDemo = () => {
    select(null);
    applyLocal(fixtureModel(), [demoReset()], true);
    setDemo('idle');
  };

  const status =
    atlas.mode === 'demo'
      ? { className: 'live demo', text: `${model.repo.branch ?? 'main'} · ${t.demo}` }
      : atlas.connected
        ? { className: 'live', text: `${model.repo.branch ?? 'main'} · ${t.live}` }
        : { className: 'live off', text: t.offline };

  return (
    <div className="app">
      <header className="bar">
        <button className="icon-btn menu" aria-label={t.showSidebar} onClick={() => setSideOpen((open) => !open)}>
          ☰
        </button>
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <b>Code Atlas</b>
          <span className="repo">{model.repo.name}</span>
          <span className={status.className}>
            <i />
            {status.text}
          </span>
        </div>
        <Search view={view} model={model} onPick={(id) => go(id, 1.05)} />
        {atlas.mode === 'demo' && (
          <button
            className="primary"
            disabled={demo === 'running'}
            onClick={() => (demo === 'idle' ? void runDemo() : demo === 'done' ? resetDemo() : undefined)}
          >
            {demo === 'done' ? '↺ ' : '▶ '}
            <span className="long">{demo === 'done' ? t.demoReset : t.demoRun}</span>
          </button>
        )}
        <button className="icon-btn" aria-label={t.theme} title={t.theme} onClick={toggle}>
          {theme === 'dark' ? (
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="3" />
              <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16">
              <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
            </svg>
          )}
        </button>
      </header>

      <Sidebar
        view={view}
        domains={model.domains}
        hiddenKinds={hiddenKinds}
        open={sideOpen}
        onToggleKind={(kind) =>
          setHiddenKinds((current) => {
            const next = new Set(current);
            if (!next.delete(kind)) next.add(kind);
            return next;
          })
        }
        onDomain={(id) => {
          setSideOpen(false);
          canvas.current?.fitDomain(id);
        }}
        onExternal={(id) => {
          setSideOpen(false);
          go(id, 0.7);
        }}
      />

      <Canvas
        ref={canvas}
        view={view}
        layout={layout}
        domains={model.domains}
        hiddenKinds={hiddenKinds}
        newNodes={atlas.newNodes}
        newEdges={atlas.newEdges}
        selected={selected}
        inset={selectedNode && !narrow() ? 444 : 0}
        onSelect={select}
      >
        <div className="zoombar">
          <div className="zbtns">
            <button aria-label={t.zoomIn} onClick={() => canvas.current?.zoomBy(1.3)}>
              +
            </button>
            <button aria-label={t.zoomOut} onClick={() => canvas.current?.zoomBy(1 / 1.3)}>
              −
            </button>
            <button className="txt" onClick={() => canvas.current?.fitAll()}>
              {t.fitAll}
            </button>
          </div>
        </div>
        {selectedNode ? (
          <Panel node={selectedNode} view={view} model={model} onClose={() => select(null)} onGo={(id) => go(id)} />
        ) : (
          <Feed entries={atlas.feed} hasNew={atlas.newNodes.size > 0} onClearNew={() => clearNew()} />
        )}
      </Canvas>
    </div>
  );
}
