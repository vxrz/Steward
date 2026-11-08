import os from 'node:os';
import { defineConfig } from 'vitest/config';

const coverage = process.argv.includes('--coverage');
// Test files run in parallel, each in its own process with its own server (port 0, its own data folder and, on
// PostgreSQL, its own schema). Most of a file's time is the server start, so this scales with the cores: in CI 3
// workers (a hosted runner has 4 vCPUs), locally half of the cores. --maxWorkers=1 runs one file at a time.
const maxWorkers = process.env.CI ? Math.max(1, Math.min(3, os.availableParallelism() - 1)) : '50%';
// SM_TEST_DATABASE_URL=postgres://… runs the whole suite on PostgreSQL (one schema per test server, see test/pg-env.ts).
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    maxWorkers,
    globalSetup: ['test/pg-global.ts'],
    setupFiles: ['test/pg-env.ts'],
    // time limits in tests stretch by this factor (test/time.ts): coverage measurement slows the code down about three
    // times, and the test files running at the same time take CPU away
    env: { SM_TEST_TIME_FACTOR: String((coverage ? 3 : 1) * 2) },
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
