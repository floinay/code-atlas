import {
  Model,
  applyBaseline,
  buildView,
  diffModels,
  edgeKey,
  emptyState,
  findingKeys,
  isEmptyDiff,
  project,
  pruneBaseline,
  runChecks,
  viewKey,
  type AtlasState,
  type ClientMessage,
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
  /** Bumps when the explored domains change: the regions moved, so the camera follows. */
  reframe: { seq: number; domain?: string };
  /** Ids of the domains that can be explored and collapsed from here. */
  explorable: Set<string>;
  /** Whether a finding can be accepted as known. */
  baseline: boolean;
};

/**
 * Without a server the browser is its own: it holds the full model, the
 * layouts of the views it has shown and the baseline of known findings.
 */
type Local = { full: Model; state: AtlasState; baseline: Set<string>; explore: string[] | undefined };
type Core = Atlas & { local?: Local };

const FEED_LIMIT = 12;
const emptyDiff: ModelDiff = {
  addedElements: [],
  removedElements: [],
  changedElements: [],
  addedEdges: [],
  removedEdges: [],
  addedChecks: [],
};
const domainsKey = (model: Model) => viewKey(model.domains.map((d) => d.id));

export const fixtureModel = (): Model => Model.parse(fixture);

/** A model of our own: everything already wrong in it is known, so only what comes later is raised. */
function localOf(model: Model, judge: boolean): Local {
  const checks = judge ? runChecks(model) : model.checks;
  const baseline = new Set(judge ? checks.flatMap(findingKeys) : []);
  return { full: { ...model, checks: judge ? applyBaseline(checks, baseline) : checks }, state: emptyState(), baseline, explore: undefined };
}

function shown(local: Local): Pick<Core, 'model' | 'view' | 'layout' | 'explorable' | 'local'> {
  const projection = project(local.full, local.explore, local.state);
  return {
    model: projection.model,
    view: projection.view,
    layout: projection.layout,
    explorable: new Set(local.full.domains.length > 1 ? local.full.domains.map((d) => d.id) : []),
    local: { ...local, state: projection.state, explore: projection.explore },
  };
}

function initial(model: Model, mode: Mode): Core {
  return {
    mode,
    connected: false,
    ...shown(localOf(model, mode !== 'static')),
    newNodes: new Set(),
    newEdges: new Set(),
    feed: [],
    epoch: 0,
    reframe: { seq: 0 },
    baseline: mode !== 'static',
  };
}

/** New elements and edges, as the canvas ids that draw them. */
function highlight(view: View, diff: ModelDiff, previous: Pick<Core, 'newNodes' | 'newEdges'>) {
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
  const socketRef = useRef<WebSocket | undefined>(undefined);
  /** The domain to frame once the server answers a change of view made here. */
  const focusRef = useRef<string | undefined>(undefined);

  /** A server message: the model, its layout and what changed. */
  const receive = useCallback((message: Extract<ServerMessage, { type: 'model' }>, first: boolean) => {
    // An answer without a diff is a change of view; the domain asked for is framed once.
    const focus = !first && isEmptyDiff(message.diff) ? focusRef.current : undefined;
    if (focus) focusRef.current = undefined;
    setState((previous) => {
      // A server started before an update keeps running the old code: fill in what it does not send yet.
      const model: Model = { ...message.model, collapsed: message.model.collapsed ?? [] };
      const view = buildView(model);
      const base = first ? { ...previous, newNodes: new Set<string>(), newEdges: new Set<string>() } : previous;
      // Same code, other regions: someone explored or collapsed a domain.
      const moved = !first && isEmptyDiff(message.diff) && domainsKey(previous.model) !== domainsKey(model);
      const { local: _local, ...rest } = previous;
      return {
        ...rest,
        mode: 'live',
        connected: true,
        model,
        view,
        layout: message.layout,
        ...highlight(view, first ? emptyDiff : message.diff, base),
        feed: [...[...message.feed].reverse(), ...(first ? [] : previous.feed)].slice(0, FEED_LIMIT),
        epoch: first ? previous.epoch + 1 : previous.epoch,
        reframe: moved ? { seq: previous.reframe.seq + 1, ...(focus ? { domain: focus } : {}) } : previous.reframe,
        explorable: new Set([...model.domains, ...model.collapsed].map((d) => d.id)),
        baseline: message.baseline ?? false,
      };
    });
  }, []);

  /** A model produced in the browser (demo mode): layout and checks are computed here. */
  const applyLocal = useCallback((next: Model, feed: FeedEntry[], reset = false) => {
    setState((previous) => {
      const before = previous.local;
      let local: Local;
      if (reset || !before) local = localOf(next, true);
      else {
        const checks = runChecks(next);
        const baseline = pruneBaseline(checks, before.baseline);
        local = { ...before, full: { ...next, checks: applyBaseline(checks, baseline) }, baseline };
      }
      const current = shown(local);
      const diff = reset ? emptyDiff : diffModels(previous.model, current.model);
      const base = reset ? { newNodes: new Set<string>(), newEdges: new Set<string>() } : previous;
      return {
        ...previous,
        ...current,
        ...highlight(current.view, diff, base),
        feed: [...[...feed].reverse(), ...previous.feed].slice(0, FEED_LIMIT),
      };
    });
  }, []);

  /** Draws only these domains in full; `null` draws all of them. `focus` is framed afterwards. */
  const explore = useCallback((domains: string[] | null, focus?: string) => {
    const socket = socketRef.current;
    if (stateRef.current.mode === 'live') {
      if (socket?.readyState !== WebSocket.OPEN) return;
      focusRef.current = focus;
      socket.send(JSON.stringify({ type: 'explore', domains } satisfies ClientMessage));
      return;
    }
    setState((previous) => {
      if (!previous.local) return previous;
      const current = shown({ ...previous.local, explore: domains ?? undefined });
      if (domainsKey(current.model) === domainsKey(previous.model)) return previous;
      return {
        ...previous,
        ...current,
        ...highlight(current.view, emptyDiff, previous),
        reframe: { seq: previous.reframe.seq + 1, ...(focus ? { domain: focus } : {}) },
      };
    });
  }, []);

  /** Accepts a finding as known, or raises it again. */
  const markCheck = useCallback((id: string, known: boolean) => {
    if (stateRef.current.mode === 'live') {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'check', id, known } satisfies ClientMessage));
      return;
    }
    setState((previous) => {
      const local = previous.local;
      const check = local?.full.checks.find((c) => c.id === id);
      if (!local || !check) return previous;
      const baseline = new Set(local.baseline);
      for (const key of findingKeys(check)) {
        if (known) baseline.add(key);
        else baseline.delete(key);
      }
      const current = shown({ ...local, baseline, full: { ...local.full, checks: applyBaseline(local.full.checks, baseline) } });
      return { ...previous, ...current, ...highlight(current.view, emptyDiff, previous) };
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

    const extracted = (model: Model, edges: number, file: string): FeedEntry => ({
      at: new Date().toISOString(),
      kind: 'info',
      subject: {
        type: 'extracted',
        domains: model.domains.length,
        elements: model.elements.filter((e) => e.kind !== 'external').length,
        edges,
        ms: 0,
      },
      file,
    });

    const startDemo = () => {
      const start = initial(fixtureModel(), 'demo');
      setState({
        ...start,
        epoch: 1,
        feed: [
          { at: new Date().toISOString(), kind: 'info', subject: { type: 'watching', pattern: 'features/**' }, file: 'watch: features/**' },
          extracted(start.model, start.view.edges.length, start.model.domains.map((d) => d.path).join(' · ')),
        ],
      });
    };

    const connect = (first: boolean) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      socket = new WebSocket(url);
      socketRef.current = socket;
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
      if (closed) return;
      const start = initial(model, 'static');
      setState({ ...start, epoch: 1, feed: [extracted(start.model, start.view.edges.length, url)] });
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
  return useMemo(
    () => ({ atlas, applyLocal, explore, markCheck, log, clearNew, stateRef }),
    [atlas, applyLocal, explore, markCheck, log, clearNew],
  );
}

/**
 * Opens a source file in the editor through the server. Resolves with what
 * went wrong, or with nothing when the editor was started.
 */
export async function openInEditor(file: string, line?: number): Promise<string | undefined> {
  try {
    const response = await fetch('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, ...(line ? { line } : {}) }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    return body.ok ? undefined : (body.error ?? String(response.status));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
