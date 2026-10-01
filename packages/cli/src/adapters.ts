import { createYedaExtractor, detectYeda } from '@code-atlas/extractor-yeda';
import type { DomainsConfig, Model } from '@code-atlas/model';

/** What every adapter gives the CLI. */
export type Extractor = {
  extract(): { model: Model; stats: { files: number; ms: number } };
  invalidate(files: string[]): void;
  /** Folders to watch, relative to the repository root. */
  watch: string[];
};

type Adapter = {
  name: string;
  detect(root: string): boolean;
  create(root: string, config: DomainsConfig): Extractor;
};

export const ADAPTERS: Adapter[] = [
  { name: 'yeda', detect: detectYeda, create: (root, config) => createYedaExtractor(root, config) },
];

export function pickAdapter(root: string, name?: string): Adapter {
  const adapter = name ? ADAPTERS.find((a) => a.name === name) : ADAPTERS.find((a) => a.detect(root));
  if (adapter) return adapter;
  const known = ADAPTERS.map((a) => a.name).join(', ');
  throw new Error(
    name
      ? `Unknown adapter "${name}". Available: ${known}.`
      : `No adapter recognises ${root}. Pass --adapter (available: ${known}).`,
  );
}
