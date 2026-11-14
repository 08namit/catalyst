import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e tests drive the built CLI (dist/); run them with `npm run test:e2e`, which builds first.
    exclude: process.env.CATALYST_E2E === '1' ? [] : ['test/e2e/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
