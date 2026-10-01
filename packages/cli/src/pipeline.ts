import { collapseDomains, type DomainsConfig, type Model } from '@code-atlas/model';
import { execFileSync } from 'node:child_process';
import type { Extractor } from './adapters.ts';

export type RunOptions = { explore?: string[] };

/** Extracts, stamps the branch, and collapses the domains that are not explored. */
export function runExtraction(root: string, extractor: Extractor, config: DomainsConfig, options: RunOptions = {}) {
  const { model: full, stats } = extractor.extract();
  const branch = currentBranch(root);
  const ignored = new Set(config.checks?.ignore ?? []);
  const names = new Map(full.elements.map((e) => [e.id, e.name]));
  const stamped: Model = {
    ...full,
    repo: { ...full.repo, ...(branch ? { branch } : {}) },
    checks: full.checks.filter((c) => !ignored.has(c.element) && !ignored.has(names.get(c.element) ?? '')),
  };
  const explore = options.explore ?? config.explore;
  if (explore) {
    const unknown = explore.filter((id) => !stamped.domains.some((d) => d.id === id));
    if (unknown.length)
      throw new Error(
        `Unknown domain${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Found: ${stamped.domains.map((d) => d.id).join(', ')}.`,
      );
  }
  return { model: explore ? collapseDomains(stamped, explore) : stamped, stats };
}

function currentBranch(root: string): string | undefined {
  try {
    const name = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name && name !== 'HEAD' ? name : undefined;
  } catch {
    return undefined;
  }
}
