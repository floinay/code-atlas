import { createVersioningStorage, defineAggregate } from '@/platform/aggregate-versioning';
import { PageContract, PageProjections } from '@/pages/contracts';
import { pageTables } from './pages.schema';

export const PageAggregate = defineAggregate({ contract: PageContract, evolve: (state: unknown) => state });

export function createPageStorage() {
  return createVersioningStorage(PageAggregate, { projections: PageProjections, tables: pageTables });
}
