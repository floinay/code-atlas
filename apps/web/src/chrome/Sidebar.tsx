import { domainBlockId, weight, type Domain, type ElementKind, type View } from '@code-atlas/model';
import { ActionIcon, KindIcon } from '../icons.tsx';
import { KINDS, KIND_ORDER, t } from '../i18n.ts';

type Props = {
  view: View;
  /** Domains drawn in full. */
  domains: Domain[];
  /** Domains folded away. */
  collapsed: Domain[];
  /** Domains that can be explored and collapsed from here. */
  explorable: Set<string>;
  hiddenKinds: Set<ElementKind>;
  open: boolean;
  onToggleKind(kind: ElementKind): void;
  onDomain(id: string): void;
  onExternal(id: string): void;
  onExplore(id: string): void;
  onCollapse(id: string): void;
  onOnly(id: string): void;
  onAll(): void;
};

const Line = ({ dash, width = 1.6, round }: { dash?: string; width?: number; round?: boolean }) => (
  <svg viewBox="0 0 34 8">
    <path
      d="M1 4h32"
      stroke="var(--muted)"
      strokeWidth={width}
      strokeDasharray={dash}
      strokeLinecap={round ? 'round' : undefined}
      fill="none"
    />
  </svg>
);

export function Sidebar(props: Props) {
  const { view, domains, collapsed, explorable, hiddenKinds, open, onToggleKind, onDomain, onExternal } = props;
  const total = (kind: ElementKind) =>
    view.nodes.filter((n) => n.kind === kind).reduce((sum, n) => sum + weight(n), 0);
  const explored = new Set(domains.map((d) => d.id));
  // One list in one order, so a domain keeps its row whether it is drawn in full or not.
  const all = [...domains, ...collapsed].sort((a, b) => a.id.localeCompare(b.id));
  const blocks = new Set(collapsed.map((d) => domainBlockId(d.id)));
  const externals = view.nodes.filter((n) => n.kind === 'external' && !blocks.has(n.id));
  return (
    <aside className={`side${open ? ' open' : ''}`}>
      <section>
        <h3>{t.elements}</h3>
        <div className="kinds">
          {KIND_ORDER.map((kind) => {
            const off = hiddenKinds.has(kind);
            return (
              <button
                key={kind}
                className={`kind${off ? ' off' : ''}`}
                aria-pressed={!off}
                onClick={() => onToggleKind(kind)}
              >
                <KindIcon kind={kind} size={16} />
                <em>{KINDS[kind].label}</em>
                <span>{total(kind)}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <h3>
          {t.domains}
          {collapsed.length > 0 && (
            <span className="count">
              {t.exploredOf(domains.length, all.length)}
              {collapsed.some((d) => explorable.has(d.id)) && <button onClick={props.onAll}>{t.allDomains}</button>}
            </span>
          )}
        </h3>
        <div className="doms">
          {all.map((domain) => {
            const full = explored.has(domain.id);
            const can = explorable.has(domain.id);
            return (
              <div key={domain.id} className={`dom${full ? '' : ' folded'}`}>
                <button
                  className="go"
                  onClick={() => (full ? onDomain(domain.id) : can ? props.onExplore(domain.id) : onExternal(domainBlockId(domain.id)))}
                  title={full || !can ? undefined : t.expandDomain(domain.name)}
                >
                  <span>{domain.name}</span>
                  <small>{full ? domain.path : t.collapsed}</small>
                </button>
                {can && (domains.length > 1 || !full) && (
                  <button className="act only" aria-label={t.onlyDomain(domain.name)} title={t.onlyThis} onClick={() => props.onOnly(domain.id)}>
                    <ActionIcon name="only" />
                  </button>
                )}
                {can && full && domains.length > 1 && (
                  <button className="act" aria-label={t.collapseDomain(domain.name)} title={t.collapse} onClick={() => props.onCollapse(domain.id)}>
                    <ActionIcon name="collapse" />
                  </button>
                )}
                {can && !full && (
                  <button className="act" aria-label={t.expandDomain(domain.name)} title={t.expand} onClick={() => props.onExplore(domain.id)}>
                    <ActionIcon name="expand" />
                  </button>
                )}
              </div>
            );
          })}
          {externals.map((node) => (
            <div key={node.id} className="dom">
              <button className="go" onClick={() => onExternal(node.id)}>
                <span>{node.label}</span>
                <small>
                  {(node.element.kind === 'external' && node.element.system === 'domain'
                    ? t.collapsedDomain
                    : t.externalSystem
                  ).toLowerCase()}
                </small>
              </button>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>{t.links}</h3>
        <div className="legend">
          <div>
            <Line />
            {t.legendWrite}
          </div>
          <div>
            <Line dash="6 4" />
            {t.legendRead}
          </div>
          <div>
            <Line dash="1.5 4.5" width={1.8} round />
            {t.legendCall}
          </div>
        </div>
      </section>
      <p className="hint">{t.hint}</p>
    </aside>
  );
}
