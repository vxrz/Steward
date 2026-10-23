import { defineConfig } from 'vitest/config';
// SM_TEST_DATABASE_URL=postgres://… runs the whole suite on PostgreSQL (one schema per test server, see test/pg-env.ts).
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
    globalSetup: ['test/pg-global.ts'],
    setupFiles: ['test/pg-env.ts'],
  },
});
