import { Workspace } from '@code-atlas/extractor-kit';
import type { DomainsConfig, Model } from '@code-atlas/model';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExpressPrismaExtraction, type ExtractStats } from './extract.ts';

export const ADAPTER = 'express-prisma';

export type ExpressPrismaExtractor = {
  extract(): { model: Model; stats: ExtractStats };
  invalidate(files: string[]): void;
  watch: string[];
};

/** True for a package that depends on Express and has a Prisma schema. */
export function detectExpressPrisma(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    if (!dependencies['express']) return false;
    return ['prisma/schema.prisma', 'schema.prisma'].some((path) => existsSync(join(root, path)));
  } catch {
    return false;
  }
}

export function createExpressPrismaExtractor(root: string, config?: DomainsConfig): ExpressPrismaExtractor {
  const workspace = new Workspace(root);
  return {
    watch: ['src', 'prisma'].filter((path) => existsSync(join(root, path))),
    extract() {
      const extraction = new ExpressPrismaExtraction(workspace, config);
      const model = extraction.run();
      return { model, stats: extraction.stats };
    },
    invalidate(files) {
      for (const file of files) workspace.invalidate(file);
    },
  };
}

export { parsePrismaSchema } from './prisma.ts';
export type { ExtractStats } from './extract.ts';
