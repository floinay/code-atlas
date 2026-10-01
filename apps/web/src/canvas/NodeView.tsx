import type { Box, ViewNode } from '@code-atlas/model';
import { memo, type CSSProperties } from 'react';
import { ICON_PATHS } from '../icons.tsx';
import { KINDS, t } from '../i18n.ts';
import { nodeLabel, signature, type Zoom } from './labels.ts';

type Props = {
  node: ViewNode;
  box: Box;
  zoom: Zoom;
  farText: string | undefined;
  isNew: boolean;
  selected: boolean;
  highlighted: boolean;
  /** Bumped when web fonts finish loading, so labels are measured again. */
  fontEpoch: number;
};

function Signature({ text, width }: { text: string; width: number }) {
  const max = Math.floor((width - 26) / 6.65);
  const shown = text.length > max ? text.slice(0, max - 1) + '…' : text;
  const arrow = shown.indexOf('→');
  return (
    <text className="t2" x={14} y={47}>
      {arrow > -1 ? shown.slice(0, arrow) : null}
      <tspan className="ty">{arrow > -1 ? shown.slice(arrow) : shown}</tspan>
    </text>
  );
}

export const NodeView = memo(function NodeView(props: Props) {
  const { node, box, zoom, farText, isNew, selected, highlighted } = props;
  const e = node.element;
  const label = nodeLabel(node, box, zoom, farText);
  const bundled = node.members.length > 1;
  const className = [
    'node',
    `k-${node.kind}`,
    isNew && 'new',
    selected && 'sel',
    highlighted && 'hl',
  ]
    .filter(Boolean)
    .join(' ');
  const title = (
    <text className="t1" x={label.x} y={label.y} style={{ fontSize: label.size }}>
      {label.text}
    </text>
  );

  let body;
  if (e.kind === 'external') {
    body = (
      <>
        <g className="ic" transform="translate(22,24) scale(1.5)">
          {ICON_PATHS.external}
        </g>
        {title}
        <text className="t3" x={62} y={72}>
          {e.system === 'domain' ? t.collapsedDomain : t.externalSystem}
        </text>
      </>
    );
  } else if (e.kind === 'table') {
    body = (
      <>
        <path className="hdr" d={`M0 10a10 10 0 0 1 10 -10H${box.w - 10}a10 10 0 0 1 10 10V38H0z`} />
        <g className="ic" transform="translate(12,11)">
          {ICON_PATHS.table}
        </g>
        {title}
        {e.columns.map((column, i) => {
          const y = 40 + i * 21;
          return (
            <g key={column.name}>
              <line className="rowline" x1={0} x2={box.w} y1={y} y2={y} />
              {column.primaryKey && (
                <text className="pk" x={10} y={y + 14.5}>
                  PK
                </text>
              )}
              <text className="col" x={32} y={y + 15}>
                {column.name}
              </text>
              <text className="coltype" x={box.w - 12} y={y + 15} textAnchor="end">
                {column.type}
                {column.notNull && !column.primaryKey ? ' !' : ''}
              </text>
            </g>
          );
        })}
      </>
    );
  } else {
    const chip = e.kind === 'projection' ? e.entity?.name : undefined;
    body = (
      <>
        <g className="ic" transform="translate(14,12)">
          {ICON_PATHS[node.kind]}
        </g>
        {title}
        {chip ? (
          <g className="chip" transform="translate(14,35)">
            <rect width={Math.min(box.w - 28, 58 + chip.length * 6.6)} height={17} rx={8.5} />
            <text x={8} y={12.3}>
              <tspan className="ck">entity</tspan> {chip}
            </text>
          </g>
        ) : (
          <Signature text={signature(node)} width={box.w} />
        )}
        {bundled && (
          <g className="cnt" transform={`translate(${box.w - 40},14)`}>
            <rect width={28} height={18} rx={9} />
            <text x={14} y={13} textAnchor="middle">
              ×{node.members.length}
            </text>
          </g>
        )}
      </>
    );
  }

  const badgeRight = box.w - 6;
  return (
    <g
      className={className}
      transform={`translate(${box.x},${box.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${KINDS[node.kind].label} ${node.name}`}
      data-id={node.id}
      style={{ '--k': `var(--${node.kind})` } as CSSProperties}
    >
      <title>{node.name}</title>
      <rect className="nb" width={box.w} height={box.h} rx={node.kind === 'external' ? 16 : 10} />
      {body}
      {isNew && (
        <g className="newb" transform={`translate(${badgeRight - 40},-9)`}>
          <rect width={40} height={17} rx={8.5} />
          <text x={20} y={12.5} textAnchor="middle">
            {t.newBadge}
          </text>
        </g>
      )}
      {node.warning && (
        <g className="warnb" transform={`translate(${badgeRight - (isNew ? 48 : 0) - 9},0)`}>
          <circle r={10} />
          <text y={4.5} textAnchor="middle">
            !
          </text>
        </g>
      )}
    </g>
  );
});
