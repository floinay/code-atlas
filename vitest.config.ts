import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
