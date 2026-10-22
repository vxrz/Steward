// Runs the server test suite on PostgreSQL: every test server gets its own schema.
//   SM_TEST_DATABASE_URL=postgres://user@host:5432/db npm run test:pg
// Default: postgres://postgres@127.0.0.1:5432/postgres (e.g. docker run -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16)
import { spawnSync } from 'node:child_process';

const url = process.env.SM_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const r = spawnSync('npm', ['run', 'test', '-w', 'server', '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, SM_TEST_DATABASE_URL: url },
});
process.exit(r.status ?? 1);
