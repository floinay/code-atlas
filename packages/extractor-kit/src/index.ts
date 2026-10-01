/**
 * What adapters for TypeScript code bases share: a workspace that resolves
 * names without a type checker, a symbolic evaluator, a walk over everything
 * a function can reach, and a reader that turns Zod schemas into model types.
 */
export * from './ast.ts';
export * from './workspace.ts';
export * from './evaluate.ts';
export * from './reach.ts';
export * from './types.ts';
