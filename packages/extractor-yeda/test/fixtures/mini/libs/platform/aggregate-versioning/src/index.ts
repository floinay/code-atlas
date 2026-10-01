import { integer, jsonb, primaryKey, text } from 'drizzle-orm/pg-core';

// The versioned variants of the contract DSL. The extractor knows their shape
// and only reads defineVersioningTables, which builds tables from its arguments.
export const defineAggregateContract = (..._args: unknown[]): any => ({});
export const defineAggregate = (..._args: unknown[]): any => ({});
export const withVersioning = (..._args: unknown[]): any => ({});
export const defineVersioningProjections = (..._args: unknown[]): any => ({});
export const createVersioningStorage = (..._args: unknown[]): any => ({});
export const withVersioningStorage = (..._args: unknown[]): any => [];

export function defineVersioningTables(projections: unknown, options: { schema: any; prefix: string }) {
  const schema = options.schema;
  const address = () => ({
    scope: text('scope').notNull(),
    aggregate_id: text('aggregate_id').notNull(),
    generation: integer('generation').notNull(),
  });
  const drafts = schema.table(
    `${options.prefix}_drafts`,
    { ...address(), row: jsonb('row').notNull() },
    (table: any) => [primaryKey({ columns: [table.scope, table.generation, table.aggregate_id] })],
  );
  const published = schema.table(
    `${options.prefix}_published`,
    { ...address(), row: jsonb('row').notNull() },
    (table: any) => [primaryKey({ columns: [table.scope, table.generation, table.aggregate_id] })],
  );
  const versions = schema.table(
    `${options.prefix}_versions`,
    { ...address(), version_id: text('version_id').notNull(), row: jsonb('row').notNull() },
    (table: any) => [primaryKey({ columns: [table.scope, table.generation, table.aggregate_id, table.version_id] })],
  );
  const projectionState = schema.table(`${options.prefix}_projection_state`, { ...address(), state: jsonb('state') });
  return Object.freeze({ drafts, published, versions, projectionState, projections });
}
