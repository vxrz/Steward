import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Audit anchoring (server/src/audit-anchor.ts, #23): the formats an anchor can come in, anchors configured outside the
 * database that cannot be read, and the cases where no checkpoint is signed. The happy paths (export, e-mail, SIEM line)
 * are covered by audit-anchor-email.test.ts, security-review-c.test.ts and compliance-pack-trust.test.ts.
 */

let s: TestServer;
const HASH = 'ab'.repeat(32);
const env = { anchor: process.env.SM_AUDIT_ANCHOR, file: process.env.SM_AUDIT_ANCHOR_FILE };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterEach(() => {
  if (env.anchor === undefined) delete process.env.SM_AUDIT_ANCHOR;
  else process.env.SM_AUDIT_ANCHOR = env.anchor;
  if (env.file === undefined) delete process.env.SM_AUDIT_ANCHOR_FILE;
  else process.env.SM_AUDIT_ANCHOR_FILE = env.file;
});
afterAll(async () => {
  await s?.app.close();
});

describe('reading an anchor', () => {
  it('takes "seq:hash" in its spellings, a checkpoint, an export, a log line and an audit entry', async () => {
    const { parseAnchor } = await import('../src/audit-anchor.js');
    for (const text of [`12:${HASH}`, `#12=${HASH}`, `12, ${HASH.toUpperCase()}`, `12 ${HASH}`])
      expect(parseAnchor(text, 'pasted anchor')).toEqual({ source: 'pasted anchor', seq: 12, hash: HASH });
    const cp = { seq: 7, hash: HASH, digest: 'd'.repeat(64) };
    expect(parseAnchor(JSON.stringify(cp), 'x')).toMatchObject({ seq: 7, hash: HASH, digest: 'd'.repeat(64) });
    expect(parseAnchor(JSON.stringify({ checkpoint: cp }), 'x').seq).toBe(7);
    expect(parseAnchor(JSON.stringify({ auditCheckpoint: { ...cp, seq: 8 } }), 'x').seq).toBe(8);
    expect(parseAnchor(JSON.stringify({ action: 'audit.checkpoint', details: { ...cp, seq: 9 } }), 'x').seq).toBe(9);
    // a JSON-lines file: the last line with a checkpoint counts, other lines are skipped
    const lines = [
      JSON.stringify({ auditCheckpoint: { ...cp, seq: 3 } }),
      'not json',
      JSON.stringify({ msg: 'unrelated' }),
      JSON.stringify({ auditCheckpoint: { ...cp, seq: 5 } }),
    ];
    expect(parseAnchor(lines.join('\n'), 'x').seq).toBe(5);
  });

  it("refuses empty and unreadable anchors, and a signature that is not this installation's", async () => {
    const { parseAnchor } = await import('../src/audit-anchor.js');
    expect(() => parseAnchor('   ', 'pasted anchor')).toThrow(/The pasted anchor is empty/);
    expect(() => parseAnchor('hello', 'x')).toThrow(expect.objectContaining({ code: 'ANCHOR_INVALID' }));
    expect(() => parseAnchor(JSON.stringify({ seq: '1', hash: HASH }), 'x')).toThrow(expect.objectContaining({ code: 'ANCHOR_INVALID' }));
    expect(() => parseAnchor(JSON.stringify({ seq: 1, hash: HASH, signature: 'forged' }), 'x')).toThrow(
      expect.objectContaining({ code: 'ANCHOR_SIGNATURE_INVALID' }),
    );
  });

  it('a signed checkpoint of this installation is valid; changed, it is not', async () => {
    const { validCheckpoint } = await import('../src/audit-anchor.js');
    const cp = await s.api('POST', '/audit/checkpoint');
    expect(validCheckpoint(cp)).toBe(true);
    expect(validCheckpoint({ ...cp, seq: cp.seq + 1 })).toBe(false);
    expect(validCheckpoint({ ...cp, signature: undefined })).toBe(false);
  });
});

describe('anchors configured outside the database', () => {
  it('a missing or broken anchor fails the verification with its source named, instead of being ignored', async () => {
    const { configuredAnchors, verifyWithAnchors } = await import('../src/audit-anchor.js');
    process.env.SM_AUDIT_ANCHOR_FILE = path.join(os.tmpdir(), 'sm-no-such-anchor.json');
    const missing = await verifyWithAnchors();
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('The anchor file SM_AUDIT_ANCHOR_FILE cannot be used: SM_AUDIT_ANCHOR_FILE');
    expect(missing.anchors).toEqual([expect.objectContaining({ source: 'anchor file SM_AUDIT_ANCHOR_FILE', ok: false })]);
    delete process.env.SM_AUDIT_ANCHOR_FILE;
    process.env.SM_AUDIT_ANCHOR = 'garbage';
    expect(configuredAnchors().errors).toEqual([expect.objectContaining({ source: 'anchor in SM_AUDIT_ANCHOR' })]);
    expect((await verifyWithAnchors()).ok).toBe(false);
  });

  it('an anchor file that is readable takes part in the verification', async () => {
    const { configuredAnchors, verifyWithAnchors } = await import('../src/audit-anchor.js');
    const cp = await s.api('POST', '/audit/checkpoint');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-anchor-'));
    const file = path.join(dir, 'anchor.json');
    fs.writeFileSync(file, JSON.stringify(cp));
    process.env.SM_AUDIT_ANCHOR_FILE = file;
    expect(configuredAnchors().names).toContain('anchor file SM_AUDIT_ANCHOR_FILE');
    const r = await verifyWithAnchors();
    expect(r.ok).toBe(true);
    expect(r.anchors?.some((a) => a.source === 'anchor file SM_AUDIT_ANCHOR_FILE' && a.ok)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('checkpoints', () => {
  it('an interval checkpoint without new entries signs nothing; a manual one always does', async () => {
    const { createCheckpoint } = await import('../src/audit-anchor.js');
    const first = await createCheckpoint('manual');
    expect(first).not.toBeNull();
    // the checkpoint itself is the newest entry: nothing new since
    expect(await createCheckpoint('interval')).toBeNull();
    expect(await createCheckpoint('manual')).not.toBeNull();
  });

  it('checkpoints asked for at the same time run one after the other', async () => {
    const { createCheckpoint } = await import('../src/audit-anchor.js');
    const [a, b] = await Promise.all([createCheckpoint('manual'), createCheckpoint('manual')]);
    expect(a && b && b.seq > a.seq).toBe(true);
  });

  it('while the vault is locked nothing is signed', async () => {
    const { createCheckpoint, anchoringStatus } = await import('../src/audit-anchor.js');
    await s.api('POST', '/vault/lock');
    expect(await createCheckpoint('manual')).toBeNull();
    expect(anchoringStatus().latest).toBeNull();
    await s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' });
    expect(anchoringStatus().latest).not.toBeNull();
  });

  it('the hourly job starts once and stops', async () => {
    const { startAuditJobs, stopAuditJobs } = await import('../src/audit-anchor.js');
    startAuditJobs();
    startAuditJobs();
    stopAuditJobs();
    stopAuditJobs();
  });
});

describe('checkpoint e-mails to auditors', () => {
  it('takes up to 20 valid addresses, keeps the interval between 1 hour and a week, and is audited', async () => {
    const { saveEmailSettings, emailSettings } = await import('../src/audit-anchor.js');
    expect(() => saveEmailSettings({ to: ['not-an-address'] })).toThrow(expect.objectContaining({ code: 'INVALID_EMAIL' }));
    expect(() => saveEmailSettings({ to: Array.from({ length: 21 }, (_, i) => `a${i}@example.com`) })).toThrow(/At most 20/);
    expect(saveEmailSettings({ to: [' audit@example.com ', 'audit@example.com'], intervalHours: 0 })).toEqual({ to: ['audit@example.com'], intervalHours: 1 });
    expect(saveEmailSettings({ to: ['audit@example.com'], intervalHours: 10_000 }).intervalHours).toBe(168);
    expect(emailSettings()).toEqual({ to: ['audit@example.com'], intervalHours: 168 });
    expect((await s.api('GET', '/audit?action=audit.anchoring_updated&limit=1'))[0].summary).toContain('every 168 h');
    saveEmailSettings({ to: [] });
    expect((await s.api('GET', '/audit?action=audit.anchoring_updated&limit=1'))[0].summary).toBe('Checkpoint e-mails: off');
  });
});
