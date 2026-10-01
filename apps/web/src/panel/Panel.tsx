import {
  impact,
  weight,
  type Element,
  type ElementKind,
  type Model,
  type RouteElement,
  type View,
  type ViewEdge,
  type ViewNode,
} from '@code-atlas/model';
import type { CSSProperties, ReactNode } from 'react';
import { ICON_PATHS, KindIcon } from '../icons.tsx';
import { CHAIN_ORDER, KINDS, REL_IN, REL_OUT, TRIGGER, count, t } from '../i18n.ts';
import { TypeBox, type Types } from './TypeView.tsx';

type Props = {
  node: ViewNode;
  view: View;
  model: Model;
  onClose(): void;
  onGo(id: string): void;
};

const kindVar = (kind: ElementKind) => ({ '--k': `var(--${kind})` }) as CSSProperties;

function Section({ title, className, children }: { title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Link({ node, onGo }: { node: ViewNode; onGo(id: string): void }) {
  return (
    <button className="lnk" style={kindVar(node.kind)} onClick={() => onGo(node.id)}>
      <svg viewBox="0 0 16 16" style={{ fill: 'none', stroke: 'var(--k)', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
        {ICON_PATHS[node.kind]}
      </svg>
      {node.label}
      {node.members.length > 1 ? <i>×{node.members.length}</i> : null}
    </button>
  );
}

function Relation({ title, ids, view, onGo }: { title: string; ids: string[]; view: View; onGo(id: string): void }) {
  const unique = [...new Set(ids)].map((id) => view.byId.get(id)).filter((n): n is ViewNode => !!n);
  if (!unique.length) return null;
  return (
    <div className="relg">
      <small>{title}</small>
      <div>
        {unique.map((n) => (
          <Link key={n.id} node={n} onGo={onGo} />
        ))}
      </div>
    </div>
  );
}

function Chain({ ids, view }: { ids: Set<string>; view: View }) {
  const counts = new Map<ElementKind, number>();
  for (const id of ids) {
    const node = view.byId.get(id)!;
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + weight(node));
  }
  const kinds = CHAIN_ORDER.filter((k) => counts.get(k));
  return (
    <div className="chain">
      {kinds.map((kind, i) => (
        <span key={kind} style={{ display: 'contents' }}>
          {i > 0 && <span className="arr">·</span>}
          <span className="pill" style={kindVar(kind)}>
            <KindIcon kind={kind} size={12} />
            {count(counts.get(kind)!, kind)}
          </span>
        </span>
      ))}
    </div>
  );
}

const httpText = (e: RouteElement) => (e.http ? `${e.http.method} ${e.http.path}` : t.internalContract);
const isRoute = (e: Element): e is RouteElement => e.kind === 'command' || e.kind === 'query';
const real = (edges: ViewEdge[] | undefined) => (edges ?? []).filter((e) => !e.ghost);

export function Panel({ node, view, model, onClose, onGo }: Props) {
  const e = node.element;
  const types: Types = model.types;
  const bundled = node.members.length > 1;
  const { up, down } = impact(view, node.id);
  const out = real(view.out.get(node.id));
  const incoming = real(view.in.get(node.id));
  const domain = node.domain ? (model.domains.find((d) => d.id === node.domain)?.name ?? node.domain) : t.outside;
  const checks = model.checks.filter((c) => node.warning?.checkIds.includes(c.id));

  const facts: [string, ReactNode][] = [];
  if (isRoute(e) && !bundled) facts.push([t.call, <code>{httpText(e)}</code>]);
  if ((isRoute(e) || e.kind === 'subscription') && e.permission)
    facts.push([t.permission, <span className="perm">{e.permission}</span>]);
  if (e.kind === 'subscription' && e.path) facts.push([t.call, <code>GET {e.path}</code>]);
  if (e.kind === 'worker') facts.push([t.trigger, TRIGGER[e.trigger]]);
  if (e.kind === 'aggregate' && e.storage)
    facts.push([
      t.storage,
      <code>
        {[
          e.storage.kind === 'event-store' ? 'event store' : e.storage.kind,
          e.storage.stream && `${t.stream} ${e.storage.stream}-{id}`,
          e.storage.snapshot && 'snapshot',
        ]
          .filter(Boolean)
          .join(' · ')}
      </code>,
    ]);

  const routes = node.members.filter(isRoute);
  const sameInput = routes.every((r) => JSON.stringify(r.input) === JSON.stringify(routes[0]?.input));
  const groupBy = (edges: ViewEdge[], pick: (edge: ViewEdge) => string) => {
    const groups = new Map<string, string[]>();
    for (const edge of edges) groups.set(edge.kind, [...(groups.get(edge.kind) ?? []), pick(edge)]);
    return [...groups];
  };
  const description = bundled ? t.bundleDescription(node.members.length, node.kind) : e.description;

  return (
    <aside className="panel" style={kindVar(node.kind)}>
      <div className="ph">
        <span className="kindlabel">
          <KindIcon kind={node.kind} />
          {KINDS[node.kind].label} <small>· {domain}</small>
        </span>
        <button className="close" aria-label={t.close} onClick={onClose}>
          ×
        </button>
        <h2>{bundled ? node.label : e.name}</h2>
      </div>
      <div className="pb">
        {checks.map((check) => (
          <div className="warnbox" key={check.id}>
            <b>{t.checkTitle}</b>{' '}
            {t.checkMessage(check.detail.event, check.detail.aggregate, check.detail.consumers, check.detail.handledSiblings)}
          </div>
        ))}
        {description && <p>{description}</p>}
        {facts.length > 0 && (
          <dl className="facts">
            {facts.map(([name, value], i) => (
              <span key={i} style={{ display: 'contents' }}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </span>
            ))}
          </dl>
        )}
        {bundled && (
          <Section title={t.bundleTitle(node.members.length)}>
            <ul className="members">
              {node.members.map((m) => (
                <li key={m.id}>
                  <code>{m.name}</code>
                  <span>{isRoute(m) ? httpText(m) : ''}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {routes.length > 0 &&
          routes[0]!.input &&
          (sameInput ? (
            <Section title={t.accepts}>
              <TypeBox expr={routes[0]!.input} types={types} />
            </Section>
          ) : (
            <Section title={t.accepts}>
              {routes.map((r, i) => (
                <details className="member" key={r.id} open={i === 0}>
                  <summary>{r.label}</summary>
                  {r.input && <TypeBox expr={r.input} types={types} />}
                </details>
              ))}
            </Section>
          ))}
        {isRoute(e) &&
          e.responses.map((response) => (
            <Section
              key={response.status}
              title={
                <>
                  {t.returns} <span className="st">{response.status}</span>
                </>
              }
            >
              <TypeBox expr={response.body} types={types} />
            </Section>
          ))}
        {isRoute(e) && e.errors && (e.errors.statuses.length > 0 || e.errors.codes.length > 0) && (
          <Section title={t.errors}>
            <div className="errs">
              {e.errors.statuses.map((status) => (
                <span key={status}>{status}</span>
              ))}
            </div>
            {e.errors.codes.length > 0 && (
              <p className="empty" style={{ marginTop: 8 }}>
                <code>code</code>: {e.errors.codes.join(', ')}
              </p>
            )}
          </Section>
        )}
        {e.kind === 'aggregate' && e.state && (
          <Section title={t.state}>
            <TypeBox expr={e.state} types={types} />
          </Section>
        )}
        {e.kind === 'event' && e.payload && (
          <Section title={t.payload}>
            <TypeBox expr={e.payload} types={types} />
          </Section>
        )}
        {e.kind === 'subscription' && e.row && (
          <Section title={t.streamRow}>
            <TypeBox expr={e.row} types={types} />
          </Section>
        )}
        {e.kind === 'projection' && e.entity && (
          <Section title={t.entity}>
            <div className="entity">
              <div className="eh">
                <span className="en">
                  <small>entity</small>
                  {e.entity.name}
                </span>
                <span className="pills">
                  {e.entity.permissions.map((p) => (
                    <span className="pill" key={p} style={kindVar('projection')}>
                      {p}
                    </span>
                  ))}
                </span>
              </div>
              {e.entity.row && <TypeBox expr={e.entity.row} types={types} />}
              {e.entity.search && (
                <dl className="facts">
                  <dt>{t.searchFields}</dt>
                  <dd>
                    <code>{e.entity.search.join(', ')}</code>
                  </dd>
                </dl>
              )}
              {e.entity.consumer && (
                <dl className="facts">
                  <dt>{t.consumer}</dt>
                  <dd>
                    <code>{e.entity.consumer}</code>
                  </dd>
                </dl>
              )}
            </div>
          </Section>
        )}
        {e.kind === 'table' && (
          <Section title={t.structure}>
            <div className="dbt">
              <div className="dh">
                {e.schema && <span>{e.schema}.</span>}
                <b>{e.label}</b>
              </div>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>{t.column}</th>
                    <th>{t.type}</th>
                  </tr>
                </thead>
                <tbody>
                  {e.columns.map((column) => (
                    <tr key={column.name}>
                      <td className="k">{column.primaryKey ? 'PK' : ''}</td>
                      <td>{column.name}</td>
                      <td className="t">
                        {column.type}
                        {column.notNull && !column.primaryKey ? ` · ${t.notNull}` : ''}
                        {column.note ? ` · ${column.note}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {e.indexes.map((index) => (
                <div className="idx" key={index.name}>
                  {index.unique ? 'unique index' : 'index'} {index.name} ({index.columns.join(', ')})
                </div>
              ))}
            </div>
          </Section>
        )}
        {e.kind === 'projection' ? (
          <Section title={t.dataFlow}>
            <div className="rels">
              <Relation title={t.listens} ids={incoming.filter((x) => x.kind === 'handles').map((x) => x.source)} view={view} onGo={onGo} />
              <Relation title={t.writes} ids={out.filter((x) => x.kind === 'writes').map((x) => x.target)} view={view} onGo={onGo} />
              <Relation title={t.streamsTo} ids={out.filter((x) => x.kind === 'streams').map((x) => x.target)} view={view} onGo={onGo} />
              <Relation title={t.readBy} ids={out.filter((x) => x.kind === 'reads').map((x) => x.target)} view={view} onGo={onGo} />
            </div>
          </Section>
        ) : (
          (out.length > 0 || incoming.length > 0 || view.appends.has(node.id)) && (
            <Section title={t.direct}>
              <div className="rels">
                <Relation title={t.appends} ids={view.appends.get(node.id) ?? []} view={view} onGo={onGo} />
                {groupBy(incoming, (x) => x.source).map(([kind, ids]) => (
                  <Relation key={`in-${kind}`} title={REL_IN[kind as keyof typeof REL_IN]} ids={ids} view={view} onGo={onGo} />
                ))}
                {groupBy(out, (x) => x.target).map(([kind, ids]) => (
                  <Relation key={`out-${kind}`} title={REL_OUT[kind as keyof typeof REL_OUT]} ids={ids} view={view} onGo={onGo} />
                ))}
              </div>
            </Section>
          )
        )}
        {down.size > 0 && (
          <Section title={t.affects}>
            <Chain ids={down} view={view} />
          </Section>
        )}
        {up.size > 0 && (
          <Section title={t.comesFrom}>
            <Chain ids={up} view={view} />
          </Section>
        )}
        <Section title={t.code} className="src">
          {node.members.map((m) => (
            <div key={m.id}>
              <code>
                {m.evidence.file}
                {m.kind !== 'external' ? `:${m.evidence.line}` : ''}
              </code>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  );
}
