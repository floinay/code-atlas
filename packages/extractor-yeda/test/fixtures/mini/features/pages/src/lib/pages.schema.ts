import { defineVersioningTables } from '@/platform/aggregate-versioning';
import { PageProjections } from '@/pages/contracts';
import { pgSchema, text } from 'drizzle-orm/pg-core';

export const pagesSchema = pgSchema('pages');
export const pageTables = defineVersioningTables(PageProjections, { schema: pagesSchema, prefix: 'page' });
export const { drafts: pageDrafts, published: pagePublished } = pageTables;

export const pageAudit = pagesSchema.table('audit', { id: text().primaryKey(), order_id: text().notNull(), at: text().notNull() });
