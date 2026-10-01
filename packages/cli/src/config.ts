import { DomainsConfig } from '@code-atlas/model';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const CONFIG_DIR = '.code-atlas';
export const DOMAINS_FILE = `${CONFIG_DIR}/domains.yaml`;
export const LAYOUT_FILE = `${CONFIG_DIR}/layout.json`;

/** Reads `.code-atlas/domains.yaml`. A missing file means "derive everything from folders". */
export function loadDomainsConfig(root: string): DomainsConfig {
  const file = join(root, DOMAINS_FILE);
  if (!existsSync(file)) return DomainsConfig.parse({});
  const raw = parse(readFileSync(file, 'utf8')) ?? {};
  const result = DomainsConfig.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`${DOMAINS_FILE} is not valid:\n${problems}`);
  }
  return result.data;
}
