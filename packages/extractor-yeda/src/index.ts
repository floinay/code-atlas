import type { DomainsConfig, Model } from '@code-atlas/model';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { YedaExtraction, type ExtractStats } from './extract.ts';
import { Workspace } from './workspace.ts';

export const ADAPTER = 'yeda';

export type YedaExtractor = {
  /** Reads the repository and returns the full model. */
  extract(): { model: Model; stats: ExtractStats };
  /** Marks files as changed. Only these are parsed again on the next extract. */
  invalidate(files: string[]): void;
  /** Folders whose changes can alter the model, relative to the repo root. */
  watch: string[];
};

/** True when `root` looks like a Yeda monorepo: features with contract packages. */
export function detectYeda(root: string): boolean {
  return existsSync(join(root, 'features')) && existsSync(join(root, 'libs', 'platform', 'route-contracts'));
}

export function createYedaExtractor(root: string, config?: DomainsConfig): YedaExtractor {
  const workspace = new Workspace(root);
  return {
    watch: ['features', 'libs/platform'],
    extract() {
      const extraction = new YedaExtraction(workspace, config ? { config } : {});
      const model = extraction.run();
      return { model, stats: extraction.stats };
    },
    invalidate(files) {
      for (const file of files) workspace.invalidate(file);
    },
  };
}

export type { ExtractStats } from './extract.ts';
