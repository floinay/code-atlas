import type { Element, Model, View, ViewNode } from '@code-atlas/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KindIcon } from '../icons.tsx';
import { t } from '../i18n.ts';

/** Everything a node can be found by: names, routes, entity names and type names. */
function haystack(element: Element): string {
  const parts: unknown[] = [element.name, element.label];
  switch (element.kind) {
    case 'command':
    case 'query':
      parts.push(element.http?.path, element.permission, element.input, element.responses);
      break;
    case 'event':
      parts.push(element.payload);
      break;
    case 'aggregate':
      parts.push(element.state);
      break;
    case 'projection':
      parts.push(element.entity);
      break;
    case 'subscription':
      parts.push(element.row, element.path);
      break;
    case 'table':
      parts.push(element.columns.map((c) => c.name));
      break;
  }
  return parts
    .filter(Boolean)
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
    .toLowerCase();
}

type Props = { view: View; model: Model; onPick(id: string): void };

export function Search({ view, model, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const corpus = useMemo(
    () => view.nodes.map((node) => ({ node, text: node.members.map(haystack).join(' ') })),
    [view],
  );
  const needle = query.trim().toLowerCase();
  const hits = useMemo<ViewNode[]>(() => {
    if (!needle) return [];
    const inName = (n: ViewNode) => Number(n.name.toLowerCase().includes(needle) || n.label.toLowerCase().includes(needle));
    return corpus
      .filter((c) => c.text.includes(needle))
      .map((c) => c.node)
      .sort((a, b) => inName(b) - inName(a))
      .slice(0, 9);
  }, [corpus, needle]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === '/' && document.activeElement !== input.current) {
        ev.preventDefault();
        input.current?.focus();
      }
    };
    const onDown = (ev: PointerEvent) => {
      if (!box.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, []);

  const go = (node: ViewNode | undefined) => {
    if (!node) return;
    setOpen(false);
    input.current?.blur();
    onPick(node.id);
  };
  const domainName = (node: ViewNode) =>
    node.domain ? (model.domains.find((d) => d.id === node.domain)?.name ?? node.domain) : t.external;

  return (
    <div className="search" ref={box}>
      <input
        ref={input}
        type="search"
        value={query}
        placeholder={t.searchPlaceholder}
        aria-label={t.searchLabel}
        autoComplete="off"
        onChange={(ev) => {
          setQuery(ev.target.value);
          setIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') go(hits[index]);
          if (ev.key === 'Escape') {
            setQuery('');
            setOpen(false);
            input.current?.blur();
          }
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const step = ev.key === 'ArrowDown' ? 1 : -1;
            setIndex((i) => (i + step + hits.length) % Math.max(1, hits.length));
          }
        }}
      />
      {open && needle && (
        <div className="results">
          {hits.length ? (
            hits.map((node, i) => (
              <button key={node.id} className={i === index ? 'on' : ''} onClick={() => go(node)}>
                <KindIcon kind={node.kind} />
                <span>{node.members.length > 1 ? node.label : node.name}</span>
                <small>{domainName(node)}</small>
              </button>
            ))
          ) : (
            <p className="empty" style={{ padding: 8, margin: 0 }}>
              {t.nothingFound}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
