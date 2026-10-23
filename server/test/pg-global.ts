/** vitest global setup: with SM_TEST_DATABASE_URL, drops the schemas this run created. */
export default function setup(): (() => Promise<void>) | void {
  const url = process.env.SM_TEST_DATABASE_URL;
  if (!url) return;
  const prefix = `smt_${Date.now().toString(36)}`;
  process.env.SM_TEST_SCHEMA_PREFIX = prefix;
  return async () => {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query<{ nspname: string }>('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1', [`${prefix}\\_%`]);
      for (const { nspname } of r.rows) await c.query(`DROP SCHEMA "${nspname}" CASCADE`);
    } finally {
      await c.end();
    }
  };
}
