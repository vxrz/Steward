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

describe('stored file paths in a migration package', () => {
  it('become paths in this data folder, and paths that lead elsewhere are refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mp-'));
    try {
      const { Db } = await import('../src/db.js');
      const { fixStoredPaths } = await import('../src/migration/import.js');
      const d = new Db({ kind: 'sqlite', file: path.join(dir, 'staging.db') });
      try {
        d.exec('PRAGMA foreign_keys = OFF');
        const artifact = (id: string, p: string) =>
          d.run(
            `INSERT INTO run_artifacts (id, run_id, step_key, kind, name, mime, path, sha256, size, created_at) VALUES (?, 'run_1', 's', 'screenshot', 'a.png', 'image/png', ?, 'x', 1, 'now')`,
            id,
            p,
          );
        artifact('a1', '@data/artifacts/run_1/a.png');
        const dataDir = path.join(dir, 'data');
        fixStoredPaths(d, dataDir);
        expect(d.get<{ path: string }>("SELECT path FROM run_artifacts WHERE id = 'a1'")!.path).toBe(path.join(dataDir, 'artifacts', 'run_1', 'a.png'));
        for (const bad of ['/etc/shadow', '@data/artifacts/../../vault.json', '@data/records/x/y.pdf', 'C:\\Windows\\win.ini']) {
          d.run('DELETE FROM run_artifacts');
          artifact('a2', bad);
          expect(() => fixStoredPaths(d, dataDir), bad).toThrow(/unsafe file path/);
        }
        d.run('DELETE FROM run_artifacts');
        d.run(
          `INSERT INTO record_attachments (id, record_id, kind, filename, mime, size, sha256, path, revision, details, created_at, created_by)
           VALUES ('att', 'rec', 'file', 'x.pdf', 'application/pdf', 1, 'x', '../../vault.json', 1, '{}', 'now', 'dana')`,
        );
        expect(() => fixStoredPaths(d, dataDir)).toThrow(/unsafe file path in record_attachments/);
      } finally {
        d.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
