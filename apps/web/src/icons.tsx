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

/** 16×16 stroke icons for actions. They take the text colour. */
export const ACTION_PATHS = {
  /** Two chevrons closing on each other: fold a domain into a block. */
  collapse: <path d="M4 2.5 8 6l4-3.5M4 13.5 8 10l4 3.5" />,
  /** Two chevrons moving apart: unfold a block into a domain. */
  expand: <path d="M4 6.5 8 3l4 3.5M4 9.5 8 13l4-3.5" />,
  only: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="1.7" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 3.2H4.3A1.3 1.3 0 0 0 3 4.5v6.2" />
    </>
  ),
  open: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />,
} satisfies Record<string, ReactNode>;

export function ActionIcon({ name, size = 14 }: { name: keyof typeof ACTION_PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', flex: 'none' }}
    >
      {ACTION_PATHS[name]}
    </svg>
  );
}
