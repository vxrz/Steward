import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_TYPE_ID } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The migration "records-003-documents" on a database that existed before living documents: existing
 * records stay exactly as they were, and the built-in type DOC is added (or another key when an
 * installation already uses DOC).
 */

let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

describe('records-003-documents on an existing database', () => {
  it('keeps existing records unchanged and adds the DOC type', async () => {
    const { db, namedMigrations } = await import('../src/db.js');
    const { resetTypeSeed } = await import('../src/records/types.js');
    // an installation with records of the old workflows
    const cr = await s.api('POST', '/records', { type: 'CR', title: 'Before the update', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
    await s.api('PUT', `/records/${cr.id}`, { body: '## Description\n\nOld text.\n' });
    await s.api('POST', `/records/${cr.id}/transition`, { action: 'submit' });
    const adr = await s.api('POST', '/records', { type: 'ADR', title: 'Old decision' });
    // back to the schema before the migration (and a custom type that already uses the key DOC)
    db().exec(`DROP TABLE record_review_reminders; DROP TABLE record_reviews; DROP TABLE record_editions; DROP TABLE record_documents;`);
    db().run('DELETE FROM record_types WHERE id = ?', DOCUMENT_TYPE_ID);
    db().exec('ALTER TABLE record_types DROP COLUMN review_interval_months');
    db().run("DELETE FROM schema_migrations WHERE name = 'records-003-documents'");
    const now = new Date().toISOString();
    db().run(
      "INSERT INTO record_types (id, key, name, description, workflow, template, fields, builtin, archived, created_at, updated_at, updated_by) VALUES ('rty_custom_doc', 'DOC', 'Documentation (own)', '', 'decision', '', '[]', 0, 0, ?, ?, 'admin')",
      now,
      now,
    );
    const snapshot = () => ({
      records: db().all('SELECT * FROM records ORDER BY id'),
      versions: db().all('SELECT * FROM record_versions ORDER BY record_id, version'),
      events: db().all('SELECT * FROM record_events ORDER BY id'),
      types: db().all('SELECT id, key, name, workflow, template, fields FROM record_types ORDER BY id'),
    });
    const before = snapshot();

    // the update: the named migration runs on the existing data, the types are seeded again on first use
    const m = namedMigrations(db().dialect).find((x) => x.name === 'records-003-documents')!;
    db().tx(() => {
      db().exec(m.sql);
      db().run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
    });
    resetTypeSeed();
    const types = await s.api('GET', '/record-types');

    const after = snapshot();
    expect(after.records).toEqual(before.records);
    expect(after.versions).toEqual(before.versions);
    expect(after.events).toEqual(before.events);
    expect(after.types.filter((t: any) => t.id !== DOCUMENT_TYPE_ID)).toEqual(before.types);
    // the built-in type is there, under another key because DOC is taken
    const doc = types.find((t: any) => t.id === DOCUMENT_TYPE_ID);
    expect(doc).toMatchObject({ key: 'SDOC', name: 'Service documentation', workflow: 'document', reviewIntervalMonths: 12, builtin: true });
    expect(types.find((t: any) => t.id === 'rty_custom_doc')).toMatchObject({ key: 'DOC', reviewIntervalMonths: null });
    // the old records read and behave as before
    const frozen = await s.api('GET', `/records/${cr.id}`);
    expect(frozen).toMatchObject({ status: 'submitted', frozen: true, tampered: false, document: null });
    expect((await s.api('GET', `/records/${adr.id}`)).status).toBe('draft');
    // and a document can be created right away
    const d = await s.api('POST', '/records', { type: 'SDOC', title: 'After the update' });
    expect(d.document).toMatchObject({ currentEdition: null });
  });
});
