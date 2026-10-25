import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every table and every column that names a person is classified for migration packages
 * (server/src/migration/tables.ts): a new table or a new "owner"/"…_by"/"actor" column makes this test
 * fail until someone decides whether it moves, is mapped to the target's users, or is kept as history.
 */
const PERSON = /(owner|acl|assignee|responsible|recipient|subject|_by$|^actor$|^author|^approved_by$|reviewer|user_id|members)/;

describe('migration package classification', () => {
  it('classifies every table and every column that names people', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mt-'));
    try {
      const { Db } = await import('../src/db.js');
      const { tables, columns } = await import('../src/cli/db-copy.js');
      const { NOT_MOVED, USER_REFS, HISTORY_COLUMNS, NOT_PEOPLE_COLUMNS, USER_ID_TABLES } = await import('../src/migration/tables.js');
      const d = new Db({ kind: 'sqlite', file: path.join(dir, 'x.db') });
      try {
        const known = new Set([
          ...USER_REFS.map((r) => `${r.table}.${r.column}`),
          ...HISTORY_COLUMNS,
          ...NOT_PEOPLE_COLUMNS,
          ...Object.entries(USER_ID_TABLES).map(([t, c]) => `${t}.${c}`),
        ]);
        const unclassified: string[] = [];
        for (const t of tables(d)) {
          if (t in NOT_MOVED) continue;
          for (const c of columns(d, t)) if (PERSON.test(c) && !known.has(`${t}.${c}`)) unclassified.push(`${t}.${c}`);
        }
        expect(unclassified, 'person columns missing from server/src/migration/tables.ts').toEqual([]);
        // and nothing stale
        const all = new Set(tables(d).flatMap((t) => columns(d, t).map((c) => `${t}.${c}`)));
        expect([...known].filter((k) => !all.has(k))).toEqual([]);
        const meta = ['sqlite_sequence', 'schema_version', 'schema_migrations'];
        expect(Object.keys(NOT_MOVED).filter((t) => !tables(d).includes(t) && !meta.includes(t))).toEqual([]);
        // credentials are re-encrypted on import: their tables must move
        const { ENCRYPTED_COLUMNS } = await import('../src/vault-rotation.js');
        const encryptedNotMoved = ENCRYPTED_COLUMNS.filter((c) => c.table in NOT_MOVED && !['identity_providers', 'sync_sources'].includes(c.table));
        expect(encryptedNotMoved).toEqual([]);
      } finally {
        d.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
