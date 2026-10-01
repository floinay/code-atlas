import * as z from 'zod/v4';
import {
  defineAggregateContract,
  defineVersioningProjections,
  withVersioning,
} from '@/platform/aggregate-versioning';
import { defineProjection } from '@/platform/projection-contracts';
import { definePermission, defineRoute, response, withHttp } from '@/platform/route-contracts';

export const Page = z.strictObject({
  id: z.uuidv7(),
  title: z.string().min(1).max(120),
  body: z.string(),
});
const permission = (key: string) => definePermission(`pages.${key}`, {});
export const PagePermissions = { edit: permission('edit'), read: permission('read'), history: permission('history') };

/** No hand-written events: the versioning platform generates the family. */
export const PageContract = defineAggregateContract(
  { namespace: 'shop', type: 'Page', schema: Page, events: [] as const },
  withVersioning({ key: 'pages', dataSchemaVersion: 1, lifecycle: { archive: true } }),
);
export const PageProjections = defineVersioningProjections(PageContract.versioning, {
  key: 'pages.pages',
  roleKeys: { drafts: 'pages.page_drafts', published: 'pages.page_published', versions: 'pages.page_versions' },
  generations: { drafts: 1, published: 1, versions: 1 },
  permissions: { drafts: PagePermissions.read, published: PagePermissions.read, versions: PagePermissions.history },
});

const address = z.strictObject({ pageId: z.uuidv7() });
const http = (operation: string) => withHttp({ method: 'POST', path: `/api/pages/${operation}` });
const route = (name: string, input: z.ZodType, body: z.ZodType) =>
  defineRoute({ name: `pages.${name}`, input, responses: [response(200, body)] }, http(name));

export const PageRoutes = {
  save: route('save', address.extend({ data: Page }), Page),
  publish: route('publish', address, Page),
  getDraft: route('get-draft', address, Page),
  list: route('list', z.strictObject({}), z.array(Page)),
} as const;
export const PageLifecycleRoutes = {
  archive: route('archive', address, Page),
  unarchive: route('unarchive', address, Page),
} as const;

export const PageAudit = z.strictObject({ id: z.string(), orderId: z.uuidv7(), at: z.iso.datetime() });
/** A projection without an entity: a plain event listener fills it. */
export const PageAuditProjection = defineProjection({ key: 'pages.audit', row: PageAudit });
