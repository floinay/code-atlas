import { DomainsConfig } from '@code-atlas/model';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

export const CONFIG_DIR = '.code-atlas';
export const DOMAINS_FILE = `${CONFIG_DIR}/domains.yaml`;
export const LAYOUT_FILE = `${CONFIG_DIR}/layout.json`;

/**
 * Reads the domains file: `.code-atlas/domains.yaml` in the repository, or the
 * file given with `--config`. A missing default file means "derive everything
 * from folders"; a missing file that was asked for by name is an error.
 */
export function loadDomainsConfig(root: string, file?: string): DomainsConfig {
  const path = file ?? join(root, DOMAINS_FILE);
  if (!existsSync(path)) {
    if (file) throw new Error(`${file} does not exist.`);
    return DomainsConfig.parse({});
  }
  const raw = parse(readFileSync(path, 'utf8')) ?? {};
  const result = DomainsConfig.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`${file ? relative(process.cwd(), file) || file : DOMAINS_FILE} is not valid:\n${problems}`);
  }
  return result.data;
}
