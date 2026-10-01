import { weight, type Domain, type ElementKind, type View } from '@code-atlas/model';
import { KindIcon } from '../icons.tsx';
import { KINDS, KIND_ORDER, t } from '../i18n.ts';

type Props = {
  view: View;
  domains: Domain[];
  hiddenKinds: Set<ElementKind>;
  open: boolean;
  onToggleKind(kind: ElementKind): void;
  onDomain(id: string): void;
  onExternal(id: string): void;
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

export function Sidebar({ view, domains, hiddenKinds, open, onToggleKind, onDomain, onExternal }: Props) {
  const total = (kind: ElementKind) =>
    view.nodes.filter((n) => n.kind === kind).reduce((sum, n) => sum + weight(n), 0);
  const externals = view.nodes.filter((n) => n.kind === 'external');
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
        <h3>{t.domains}</h3>
        <div className="doms">
          {domains.map((domain) => (
            <button key={domain.id} className="dom" onClick={() => onDomain(domain.id)}>
              <span>{domain.name}</span>
              <small>{domain.path}</small>
            </button>
          ))}
          {externals.map((node) => (
            <button key={node.id} className="dom" onClick={() => onExternal(node.id)}>
              <span>{node.label}</span>
              <small>
                {(node.element.kind === 'external' && node.element.system === 'domain'
                  ? t.collapsedDomain
                  : t.externalSystem
                ).toLowerCase()}
              </small>
            </button>
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
