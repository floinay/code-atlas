import {
  buildView,
  computeLayout,
  diffModels,
  edgeKey,
  runChecks,
  Model,
  type FeedEntry,
  type Layout,
  type ModelDiff,
  type ServerMessage,
  type View,
} from '@code-atlas/model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import fixture from '@code-atlas/model/fixtures/prototype.model.json';

/** `static` shows a model file given as `?model=<url>`: no server, no demo. */
export type Mode = 'loading' | 'live' | 'demo' | 'static';
export type Atlas = {
  mode: Mode;
  connected: boolean;
  model: Model;
  view: View;
  layout: Layout;
  newNodes: Set<string>;
  newEdges: Set<string>;
  feed: FeedEntry[];
  /** Bumps whenever the whole map is replaced, so the camera can refit. */
  epoch: number;
};

const FEED_LIMIT = 12;
const emptyDiff: ModelDiff = {
  addedElements: [],
  removedElements: [],
  changedElements: [],
  addedEdges: [],
  removedEdges: [],
  addedChecks: [],
};

export const fixtureModel = (): Model => Model.parse(fixture);

type Core = Omit<Atlas, 'view'> & { view: View };

function initial(model: Model, mode: Mode): Core {
  const view = buildView(model);
  return {
    mode,
    connected: false,
    model,
    view,
    layout: computeLayout(view, model.domains),
    newNodes: new Set(),
    newEdges: new Set(),
    feed: [],
    epoch: 0,
  };
}

/** New elements and edges, as the canvas ids that draw them. */
function highlight(view: View, diff: ModelDiff, previous: Core) {
  const newNodes = new Set([...previous.newNodes].filter((id) => view.byId.has(id)));
  for (const id of diff.addedElements) {
    const node = view.nodeOf.get(id);
    if (node) newNodes.add(node);
  }
  const live = new Set(view.edges.map((e) => e.id));
  const newEdges = new Set([...previous.newEdges].filter((id) => live.has(id)));
  for (const key of diff.addedEdges) {
    const [source, kind, target] = key.split('|') as [string, string, string];
    const id = edgeKey({ source: view.nodeOf.get(source) ?? source, kind, target: view.nodeOf.get(target) ?? target });
    if (live.has(id)) newEdges.add(id);
  }
  return { newNodes, newEdges };
}

export function useAtlas() {
  const [state, setState] = useState<Core>(() => initial(fixtureModel(), 'loading'));
  const stateRef = useRef(state);
  stateRef.current = state;

  /** A server message: the model, its layout and what changed. */
  const receive = useCallback((message: Extract<ServerMessage, { type: 'model' }>, first: boolean) => {
    setState((previous) => {
      const model = message.model;
      const view = buildView(model);
      const base = first ? { ...previous, newNodes: new Set<string>(), newEdges: new Set<string>() } : previous;
      return {
        ...previous,
        mode: 'live',
        connected: true,
        model,
        view,
        layout: message.layout,
        ...highlight(view, first ? emptyDiff : message.diff, base),
        feed: [...[...message.feed].reverse(), ...(first ? [] : previous.feed)].slice(0, FEED_LIMIT),
        epoch: first ? previous.epoch + 1 : previous.epoch,
      };
    });
  }, []);

  /** A model produced in the browser (demo mode): layout and checks are computed here. */
  const applyLocal = useCallback((next: Model, feed: FeedEntry[], reset = false) => {
    setState((previous) => {
      const model = { ...next, checks: runChecks(next) };
      const view = buildView(model);
      const diff = reset ? emptyDiff : diffModels(previous.model, model);
      const base = reset ? { ...previous, newNodes: new Set<string>(), newEdges: new Set<string>() } : previous;
      return {
        ...previous,
        model,
        view,
        layout: computeLayout(view, model.domains, reset ? undefined : previous.layout),
        ...highlight(view, diff, base),
        feed: [...[...feed].reverse(), ...previous.feed].slice(0, FEED_LIMIT),
      };
    });
  }, []);

  const log = useCallback((entry: FeedEntry) => {
    setState((previous) => ({ ...previous, feed: [entry, ...previous.feed].slice(0, FEED_LIMIT) }));
  }, []);
  const clearNew = useCallback((ids?: string[]) => {
    setState((previous) => {
      if (!ids) return { ...previous, newNodes: new Set(), newEdges: new Set() };
      const newNodes = new Set(previous.newNodes);
      for (const id of ids) newNodes.delete(id);
      return { ...previous, newNodes };
    });
  }, []);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const startDemo = () => {
      const model = fixtureModel();
      const view = buildView(model);
      const elements = model.elements.filter((e) => e.kind !== 'external').length;
      const at = new Date().toISOString();
      setState({
        ...initial(model, 'demo'),
        epoch: 1,
        feed: [
          { at, kind: 'info', subject: { type: 'watching', pattern: 'features/**' }, file: 'watch: features/**' },
          {
            at,
            kind: 'info',
            subject: { type: 'extracted', domains: model.domains.length, elements, edges: view.edges.length, ms: 0 },
            file: model.domains.map((d) => d.path).join(' · '),
          },
        ],
      });
    };

    const connect = (first: boolean) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      socket = new WebSocket(url);
      let fresh = first;
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === 'feed') {
          setState((previous) => ({
            ...previous,
            feed: [...[...message.feed].reverse(), ...previous.feed].slice(0, FEED_LIMIT),
          }));
          return;
        }
        if (message.type !== 'model') return;
        receive(message, fresh);
        fresh = false;
        retry = 0;
      };
      socket.onclose = () => {
        if (closed) return;
        setState((previous) => ({ ...previous, connected: false }));
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(() => connect(false), 500 * 2 ** retry);
      };
    };

    const startStatic = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      const model = Model.parse(await response.json());
      const view = buildView(model);
      if (closed) return;
      setState({
        ...initial(model, 'static'),
        epoch: 1,
        feed: [
          {
            at: new Date().toISOString(),
            kind: 'info',
            subject: {
              type: 'extracted',
              domains: model.domains.length,
              elements: model.elements.filter((e) => e.kind !== 'external').length,
              edges: view.edges.length,
              ms: 0,
            },
            file: url,
          },
        ],
      });
    };

    const snapshot = new URLSearchParams(location.search).get('model');
    if (snapshot) {
      startStatic(snapshot).catch((error: unknown) => {
        if (closed) return;
        startDemo();
        setState((previous) => ({
          ...previous,
          feed: [
            { at: new Date().toISOString(), kind: 'warn', subject: { type: 'error', message: String(error) } },
            ...previous.feed,
          ],
        }));
      });
      return () => {
        closed = true;
      };
    }

    fetch('/api/health')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('no server'))))
      .then((body: { ok?: boolean }) => {
        if (closed) return;
        if (body?.ok) connect(true);
        else startDemo();
      })
      .catch(() => {
        if (!closed) startDemo();
      });

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [receive]);

  const atlas: Atlas = state;
  return useMemo(() => ({ atlas, applyLocal, log, clearNew, stateRef }), [atlas, applyLocal, log, clearNew]);
}
