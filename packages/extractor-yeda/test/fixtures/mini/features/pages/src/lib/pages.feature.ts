import { withVersioningStorage } from '@/platform/aggregate-versioning';
import { defineFeature, localRoute, withRoutes, withStart } from '@/platform/backend';
import { listenEvents } from '@/platform/kafka-events';
import { PageAuditProjection, PageLifecycleRoutes, PageRoutes } from '@/pages/contracts';
import { auditHandlers, pruneAudit } from './page-audit';
import { pageDrafts } from './pages.schema';
import { createPageStorage } from './pages.storage';

type Options = { makeStorage?: typeof createPageStorage };

export function createPagesFeature({ makeStorage = createPageStorage }: Options = {}) {
  let db: any = null;
  const storage = makeStorage();
  const lifecycle = (command: keyof typeof PageLifecycleRoutes) =>
    localRoute(PageLifecycleRoutes[command], (input: any) => storage[command]({ id: input.pageId }));

  return defineFeature('pages', () => [
    ...withVersioningStorage(storage),
    withRoutes([
      localRoute(PageRoutes.save, (input: any) => storage.saveDraft({ id: input.pageId, data: input.data })),
      localRoute(PageRoutes.publish, (input: any) => storage.publish({ id: input.pageId })),
      localRoute(PageRoutes.getDraft, (input: any) => storage.getDraft({ id: input.pageId })),
      localRoute(PageRoutes.list, async () => ({ status: 200 as const, body: await db.select().from(pageDrafts) })),
      lifecycle('archive'),
      lifecycle('unarchive'),
    ]),
    withStart(({ database, environment }: any) => {
      db = database.db;
      const audit = listenEvents(...auditHandlers, {
        projection: PageAuditProjection,
        consumerName: 'pages-audit',
        environment,
      });
      const timer = setInterval(() => {
        void pruneAudit(db);
      }, 3_600_000);
      return { close: async () => { clearInterval(timer); await audit.close(); } };
    }),
  ]);
}
export const pagesFeature = createPagesFeature();
