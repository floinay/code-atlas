import { pgSchema, text } from 'drizzle-orm/pg-core';

export const peopleSchema = pgSchema('people');
export const people = peopleSchema.table('people', {
  id: text().primaryKey(),
  email: text().notNull(),
  language: text().notNull(),
});
