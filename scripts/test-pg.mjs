// Runs the server test suite on PostgreSQL: every test server gets its own schema.
//   SM_TEST_DATABASE_URL=postgres://user@host:5432/db npm run test:pg
// Default: postgres://postgres@127.0.0.1:5432/postgres (e.g. docker run -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16)
import { spawnSync } from 'node:child_process';
import { npmCommand } from './npm-command.mjs';

const url = process.env.SM_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
// no shell, also on Windows: the arguments are passed through as they are (npm-command.mjs)
const [cmd, args] = npmCommand(['run', 'test', '-w', 'server', '--', ...process.argv.slice(2)]);
const r = spawnSync(cmd, args, {
  stdio: 'inherit',
  env: { ...process.env, SM_TEST_DATABASE_URL: url },
});
process.exit(r.status ?? 1);
