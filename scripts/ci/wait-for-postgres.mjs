// Waits until PostgreSQL accepts connections and answers a query (a CI service container
// needs a few seconds to initialise; the port opens before the database is ready).
//
//   node scripts/ci/wait-for-postgres.mjs [timeout seconds, default 60]
//
// Connects to SM_TEST_DATABASE_URL (as scripts/test-pg.mjs does) with the "pg" package of the
// server workspace, so run "npm ci" first. Exit status: 0 = ready, 1 = timed out, 2 = usage error.
import { createRequire } from 'node:module';

const url = process.env.SM_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const timeout = Number(process.argv[2] ?? 60);
if (!Number.isFinite(timeout) || timeout <= 0) {
  console.error(`error: invalid timeout '${process.argv[2]}'`);
  process.exit(2);
}
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = require('pg');
const safeUrl = url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');

const deadline = Date.now() + timeout * 1000;
let lastError = '';
while (Date.now() < deadline) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query('select version() as v');
    console.log(`PostgreSQL ready at ${safeUrl}: ${rows[0].v}`);
    await client.end();
    process.exit(0);
  } catch (e) {
    lastError = e.message;
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
}
console.error(`error: PostgreSQL at ${safeUrl} not ready after ${timeout}s: ${lastError}`);
process.exit(1);
