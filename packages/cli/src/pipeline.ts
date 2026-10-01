import { collapseDomains, normalizeExplore, type DomainsConfig, type Model } from '@code-atlas/model';
import { execFileSync } from 'node:child_process';
import type { Extractor } from './adapters.ts';

export type RunOptions = { explore?: string[] };

/** Extracts every domain in full, stamps the branch and drops the checks the config marks as intended. */
export function extractFull(root: string, extractor: Extractor, config: DomainsConfig) {
  const { model: full, stats } = extractor.extract();
  const branch = currentBranch(root);
  const ignored = new Set(config.checks?.ignore ?? []);
  const names = new Map(full.elements.map((e) => [e.id, e.name]));
  const model: Model = {
    ...full,
    repo: { ...full.repo, ...(branch ? { branch } : {}) },
    checks: full.checks.filter((c) => !ignored.has(c.element) && !ignored.has(names.get(c.element) ?? '')),
  };
  return { model, stats };
}

/** Refuses a selection that names a domain the model does not have. */
export function assertDomains(explore: readonly string[], model: Model) {
  const unknown = explore.filter((id) => !model.domains.some((d) => d.id === id));
  if (unknown.length)
    throw new Error(
      `Unknown domain${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Found: ${model.domains.map((d) => d.id).join(', ')}.`,
    );
}

/** Extracts, then collapses the domains that are not explored. */
export function runExtraction(root: string, extractor: Extractor, config: DomainsConfig, options: RunOptions = {}) {
  const { model: full, stats } = extractFull(root, extractor, config);
  const wanted = options.explore ?? config.explore;
  if (wanted) assertDomains(wanted, full);
  const explore = normalizeExplore(wanted, full.domains);
  return { model: explore ? collapseDomains(full, explore) : full, stats };
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
