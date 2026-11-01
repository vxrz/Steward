import { defineConfig } from 'vitest/config';

// coverage measurement slows the code down: time limits in tests stretch by this factor (test/time.ts)
const coverage = process.argv.includes('--coverage');
// SM_TEST_DATABASE_URL=postgres://… runs the whole suite on PostgreSQL (one schema per test server, see test/pg-env.ts).
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,
    globalSetup: ['test/pg-global.ts'],
    setupFiles: ['test/pg-env.ts'],
    env: { SM_TEST_TIME_FACTOR: coverage ? '3' : '1' },
    // npm run test:coverage (#23): measured in CI and reported, no minimum yet
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
