import type { DomainsConfig } from '@code-atlas/model';
import type { ADAPTERS } from './adapters.ts';

export type ServeOptions = {
  root: string;
  adapter: (typeof ADAPTERS)[number];
  config: DomainsConfig;
  port: number;
  open: boolean;
  explore?: string[];
};

/** Lands in milestone 4: extract, serve the web app, watch files, push updates. */
export async function serve(_options: ServeOptions): Promise<void> {
  throw new Error('`serve` is not implemented yet. Use `extract` and open the model in the web app.');
}
