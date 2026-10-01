import type { ElementKind } from '@code-atlas/model';
import type { ReactNode } from 'react';

/** 16×16 stroke icons, one per element kind. */
export const ICON_PATHS: Record<ElementKind, ReactNode> = {
  command: <path d="M1.5 8h11M8.5 3.5 13 8l-4.5 4.5" />,
  query: (
    <>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4 14 14" />
    </>
  ),
  worker: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.8" />
    </>
  ),
  aggregate: <path d="M8 1.6l5.5 3.2v6.4L8 14.4l-5.5-3.2V4.8z" />,
  event: <path d="M8 1.6 14.4 8 8 14.4 1.6 8z" />,
  projection: <path d="M2 2.5h12L9.6 8v4.6l-3.2 1.4V8z" />,
  table: <path d="M2 3h12v10H2zM2 6.6h12M6.3 6.6V13" />,
  subscription: (
    <>
      <path d="M3 11a5 5 0 0 1 10 0M5.5 11a2.5 2.5 0 0 1 5 0" />
      <circle cx="8" cy="11" r=".6" />
    </>
  ),
  external: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </>
  ),
};

export function KindIcon({ kind, size = 14 }: { kind: ElementKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{
        fill: 'none',
        stroke: `var(--${kind})`,
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        flex: 'none',
      }}
    >
      {ICON_PATHS[kind]}
    </svg>
  );
}
