import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allowEmailDomains, authHeaders, loginCookie, quiesce, setup, startTestServer, ADMIN, type Client, type TestServer } from './helpers.js';
import { selfSignedCertificate } from '../../e2e/support/selfsigned.js';

process.env.SM_GATUS_AUTOSTART = '0';

// Capture e-mails instead of talking to an SMTP server.
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string; attachments?: unknown[] }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string; subject: string; text: string }) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
const PW = 'Demo-password-1';
const DAY = 86400000;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );

/** Agent certificate signed by a test CA (generated once with openssl; valid until 2035/2036). */
const LEAF = `-----BEGIN CERTIFICATE-----
MIIByjCCAXCgAwIBAgICIAIwCgYIKoZIzj0EAwIwMjEYMBYGA1UEAwwPU3Rld2Fy
ZCBUZXN0IENBMRYwFAYDVQQKDA1TdGV3YXJkIFRlc3RzMB4XDTI2MTAyMjE2MDcz
N1oXDTM1MDEwODE2MDczN1owOTEfMB0GA1UEAwwWYWdlbnQtMTcucGxhbnQuZXhh
bXBsZTEWMBQGA1UECgwNU3Rld2FyZCBUZXN0czBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABGRfE2W0bnwox5Z0Ce9Y0maobaGvZpXyIS5g77u7ha1FiXrW8cjaihlE
zd8sSK+mQVZ0bw9+0+H+P7ePZx3Qr6ijbzBtMCsGA1UdEQQkMCKCFmFnZW50LTE3
LnBsYW50LmV4YW1wbGWCCGFnZW50LTE3MB0GA1UdDgQWBBQo9VI9b7/kt9QWLWO1
fEYwLTWTTTAfBgNVHSMEGDAWgBTCzDFMulbgfMYHuVY5vgG1GhiMNDAKBggqhkjO
PQQDAgNIADBFAiEAz7fyxnWuJNN29pg7L9OVDZIzqcRbFu9d6qDhqTKUKOYCID9h
akqL0Ir0O+jlZNQzzt1iIO2F0QMigSDUz6IZaOnq
-----END CERTIFICATE-----
`;
const CA = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU2gAwIBAgICEAEwCgYIKoZIzj0EAwIwMjEYMBYGA1UEAwwPU3Rld2Fy
ZCBUZXN0IENBMRYwFAYDVQQKDA1TdGV3YXJkIFRlc3RzMB4XDTI2MTAyMjE2MDcz
N1oXDTM2MTAxOTE2MDczN1owMjEYMBYGA1UEAwwPU3Rld2FyZCBUZXN0IENBMRYw
FAYDVQQKDA1TdGV3YXJkIFRlc3RzMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
Zw/zqDP38qxdB5oeR5/nK0liGBjxlGtk41O4BbbpzjRNLQOSuUdFMtYyJVPr2agJ
VDrTMQfwoxoi8vju0ZWiQqNTMFEwHQYDVR0OBBYEFMLMMUy6VuB8xge5Vjm+AbUa
GIw0MB8GA1UdIwQYMBaAFMLMMUy6VuB8xge5Vjm+AbUaGIw0MA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAIcin1waIjO/N5sxLBOfgcQvgfLPcQq1
8dRguTVA/oGFAiBL56jSUQ75LKhkwMyv2OSCgyDS/T2b7ulO8Yr0mZxQNg==
-----END CERTIFICATE-----
`;
const LEAF_FP = 'FE:E7:75:00:FE:42:7F:72:E5:DF:A8:DD:C7:8F:72:3B:E8:B7:37:EC:E1:EA:5F:6A:65:A1:BF:62:05:A1:17:A9';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const entry = (over: Record<string, unknown> = {}) => ({
  name: `Agent cert ${crypto.randomUUID().slice(0, 8)}`,
  type: 'agentCertificate',
  platformText: 'Insights Hub',
  environment: 'production',
  description: 'Agent certificate of the MindConnect IoT2050 in hall 3',
  usedBy: { text: 'Agent on IoT2050 #17', links: [] },
  owners: [
    { email: 'plant.manager@example.com', role: 'Business owner' },
    { email: 'it-ops@example.com', role: 'IT operations' },
  ],
  location: { text: 'KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-17', url: 'keepass://IT-Ops.kdbx' },
  ...over,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await quiesce(); // no late demo run may send check e-mails into the tests that compare the sent mails
  await allowEmailDomains(s, ['example.com']);
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('secret heuristics', () => {
  it('accepts ordinary documentation', async () => {
    const { findSecret } = await import('../src/credentials/secrets.js');
    for (const ok of [
      'KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-17',
      'keepass://IT-Ops.kdbx/Insights%20Hub/Agents',
      '\\\\fileserver\\it\\keepass\\plant.kdbx',
      'C:\\Users\\it\\Documents\\vault.kdbx',
      'https://portal.example.com/apps/credentials?tenant=plant-eu1&env=prod',
      'Password: see KeePass entry "Insights Hub technical user"',
      'pwd: ask-the-it-team',
      'Client id 2f9c6c1e-8a4b-4c1e-9b7a-1d2e3f4a5b6c (UUID)',
      'SHA-256 fingerprint FE:E7:75:00:FE:42:7F:72:E5:DF:A8:DD:C7:8F:72:3B:E8:B7:37:EC:E1:EA:5F:6A:65:A1:BF:62:05:A1:17:A9',
      'sha256 3b5d3c7d207e37dceeedd301e35e2e58408a2a8e74c3bd4a7b1aa29f1e1cd9a8',
      'Rotated by the vendor every 90 days; ask Business (plant.manager@example.com) before.',
      'Service account svc-iot-agent-hall3 on mindsphere tenant plantprod',
      'Hostname agent-17.plant.example, path /opt/siemens/agent/config/AgentConfiguration.json',
      'ThisIsAVeryLongCamelCaseIdentifierNameForAClass',
    ]) {
      expect(findSecret(ok), ok).toBeNull();
    }
  });

  it('rejects private keys, tokens and password values', async () => {
    const { findSecret } = await import('../src/credentials/secrets.js');
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const cases: [string, RegExp][] = [
      [privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), /private key/],
      ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', /private key/],
      ['-----BEGIN RSA PRIVATE KEY-----', /private key/],
      [
        `token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`,
        /JSON Web Token/,
      ],
      [`ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`, /GitHub/],
      ['AKIAIOSFODNN7EXAMPLE', /AWS/],
      ['xoxb-123456789012-abcdefABCDEF', /Slack/],
      ['https://svc-user:S3cr3t-Pass@db.example.com/x', /password in a URL/],
      ['password: Summer2024!', /password or key value/],
      ['client_secret = Zx81hQ7-Lm2pVb', /password or key value/],
      ['kL9xQ2mVb7Rz4WnT8pYs1Hc6Fd3Gj5Ke0aUoIyErTq', /random token/],
      [`smt_${'x'.repeat(10)}AbC123${'y'.repeat(10)}`, /Steward/],
    ];
    for (const [text, kind] of cases) expect(findSecret(text), text.slice(0, 40)).toMatch(kind);
  });

  it('refuses entries that contain a secret, without echoing it', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const msg = await errorOf(dana('POST', '/credentials', entry({ notes: `the token is ${jwt}` })));
    expect(msg).toContain('400');
    expect(msg).toContain('SECRET_DETECTED');
    expect(msg).toContain('Notes');
    expect(msg).not.toContain(jwt);
    expect(await status(dana('POST', '/credentials', entry({ location: { text: 'password: Summer2024!' } })))).toBe(400);
    expect(await status(dana('POST', '/credentials', entry({ tags: ['AKIAIOSFODNN7EXAMPLE'] })))).toBe(400);
  });
});

describe('certificates', () => {
  it('parses a PEM chain: subject, issuer, serial, fingerprint, SANs, validity', async () => {
    const r = await dana('POST', '/credentials/certificate/parse', { pem: LEAF + CA });
    expect(r).toMatchObject({
      subject: 'CN=agent-17.plant.example, O=Steward Tests',
      issuer: 'CN=Steward Test CA, O=Steward Tests',
      serialNumber: '2002',
      fingerprint256: LEAF_FP,
      subjectAltNames: ['DNS:agent-17.plant.example', 'DNS:agent-17'],
      notAfter: '2035-01-08T16:07:37.000Z',
      isCA: false,
      selfSigned: false,
      chainNotAfter: '2035-01-08T16:07:37.000Z',
    });
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]).toMatchObject({ subject: 'CN=Steward Test CA, O=Steward Tests', notAfter: '2036-10-19T16:07:37.000Z' });
  });

  it('parses DER and a generated self-signed certificate; the earliest expiry of a chain wins', async () => {
    const gen = selfSignedCertificate({ commonName: 'edge-device-4', notAfter: new Date(Date.now() + 10 * DAY) });
    const der = await dana('POST', '/credentials/certificate/parse', { contentBase64: b64(gen.der) });
    expect(der).toMatchObject({ subject: 'CN=edge-device-4', selfSigned: true });
    const chain = await dana('POST', '/credentials/certificate/parse', { pem: CA + gen.pem });
    expect(chain.subject).toBe('CN=Steward Test CA, O=Steward Tests');
    expect(chain.chainNotAfter).toBe(der.notAfter);
  });

  it('rejects private keys (PEM, DER, PKCS#12) and non-certificates, and says why', async () => {
    const gen = selfSignedCertificate({ commonName: 'x', notAfter: new Date(Date.now() + DAY) });
    const withKey = await errorOf(dana('POST', '/credentials/certificate/parse', { pem: gen.pem + gen.privateKeyPem }));
    expect(withKey).toMatch(/PRIVATE_KEY_REJECTED/);
    expect(withKey).toMatch(/private key/);
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const derKey = privateKey.export({ type: 'pkcs8', format: 'der' });
    expect(await errorOf(dana('POST', '/credentials/certificate/parse', { contentBase64: b64(derKey) }))).toMatch(/PRIVATE_KEY_REJECTED/);
    // the start of a PKCS#12 file: SEQUENCE, INTEGER 3
    expect(
      await errorOf(dana('POST', '/credentials/certificate/parse', { contentBase64: b64(Buffer.from([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03, 0x30])) })),
    ).toMatch(/PKCS#12/);
    expect(await status(dana('POST', '/credentials/certificate/parse', { pem: 'hello' }))).toBe(400);
    expect(await status(dana('POST', '/credentials/certificate/parse', { contentBase64: b64(Buffer.alloc(300 * 1024, 1)) }))).toBe(400);
    // saving an entry with a key is refused the same way, nothing is stored
    const before = (await s.api('GET', '/credentials')).items.length;
    expect(await status(dana('POST', '/credentials', entry({ certificate: { pem: gen.pem + gen.privateKeyPem } })))).toBe(400);
    expect((await s.api('GET', '/credentials')).items.length).toBe(before);
  });

  it('a certificate upload fills expiry and issue date; only metadata is stored', async () => {
    const c = await dana('POST', '/credentials', entry({ certificate: { pem: LEAF + CA } }));
    expect(c.expiresAt).toBe('2035-01-08T16:07:37.000Z');
    expect(c.certificate.fingerprint256).toBe(LEAF_FP);
    const { db } = await import('../src/db.js');
    const row = db().get<Record<string, string>>('SELECT * FROM credentials WHERE id = ?', c.id)!;
    expect(JSON.stringify(row)).not.toContain('BEGIN CERTIFICATE');
    const h = await dana('GET', `/credentials/${c.id}/history`);
    expect(h.map((e: any) => e.kind).sort()).toEqual(['certificate', 'created']);
  });
});

describe('register entries', () => {
  it('validates links: http(s) and keepass/file paths, never javascript: or data:', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox', 'JaVaScRiPt:alert(1)']) {
      expect(await errorOf(dana('POST', '/credentials', entry({ location: { text: 'x', url } }))), url).toMatch(/LOCATION_SCHEME|not allowed/);
    }
    for (const url of ['https://vault.example.com/entries/17', 'keepass://IT.kdbx', 'C:\\vault\\it.kdbx', '\\\\srv\\share\\it.kdbx', 'it-ops.kdbx']) {
      const c = await dana('POST', '/credentials', entry({ location: { text: 'x', url } }));
      expect(c.location.url).toBe(url);
    }
  });

  it('computes next rotation and review dates and the status', async () => {
    const { computeDues, worstCredentialStatus } = await import('../src/credentials/service.js');
    const now = Date.parse('2026-06-01T12:00:00Z');
    const base = {
      created_at: '2026-01-01T00:00:00.000Z',
      issued_at: null,
      last_rotated_at: null,
      last_reviewed_at: null,
      rotation_interval_days: null,
      review_interval_days: null,
      expires_at: null,
    } as any;
    expect(computeDues(base, now, 30)).toEqual([]);
    const dues = computeDues(
      { ...base, expires_at: '2026-06-20T00:00:00.000Z', rotation_interval_days: 90, last_rotated_at: '2026-03-01T00:00:00.000Z', review_interval_days: 365 },
      now,
      30,
    );
    expect(dues).toEqual([
      { kind: 'expiry', dueAt: '2026-06-20T00:00:00.000Z', daysLeft: 19, status: 'dueSoon' },
      { kind: 'rotation', dueAt: '2026-05-30T00:00:00.000Z', daysLeft: -3, status: 'overdue' },
      { kind: 'review', dueAt: '2027-01-01T00:00:00.000Z', daysLeft: 214, status: 'ok' },
    ]);
    expect(worstCredentialStatus(dues.map((d) => d.status))).toBe('overdue');
    expect(computeDues({ ...base, expires_at: '2026-05-31T00:00:00.000Z' }, now, 30)[0]!.status).toBe('expired');
    // rotation counts from the issue date when it never was rotated
    expect(computeDues({ ...base, issued_at: '2026-02-01T00:00:00.000Z', rotation_interval_days: 30 }, now, 30)[0]!.dueAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('marks rotated and reviewed (with history and audit); filters by status, type and due window', async () => {
    const c = await olivia(
      'POST',
      '/credentials',
      entry({
        type: 'technicalUser',
        name: 'svc-reader rotation test',
        rotationIntervalDays: 60,
        lastRotatedAt: new Date(Date.now() - 70 * DAY).toISOString(),
        reviewIntervalDays: 365,
      }),
    );
    expect(c.status).toBe('overdue');
    const overdue = await olivia('GET', '/credentials?status=overdue&type=technicalUser');
    expect(overdue.items.map((x: any) => x.id)).toContain(c.id);
    const r = await olivia('POST', `/credentials/${c.id}/rotated`, {
      comment: 'New password set in KeePass',
      expiresAt: new Date(Date.now() + 400 * DAY).toISOString(),
    });
    expect(r.status).toBe('ok');
    expect(Date.parse(r.nextRotationAt) - Date.now()).toBeGreaterThan(59 * DAY);
    expect(await status(olivia('POST', `/credentials/${c.id}/rotated`, { comment: 'password: Summer2024!' }))).toBe(400);
    expect(await status(olivia('POST', `/credentials/${c.id}/rotated`, { rotatedAt: new Date(Date.now() + 5 * DAY).toISOString() }))).toBe(400);
    const v = await olivia('POST', `/credentials/${c.id}/reviewed`, { comment: 'Still needed by the historian export' });
    expect(Date.parse(v.lastReviewedAt)).toBeGreaterThan(Date.now() - 60000);
    const h = await olivia('GET', `/credentials/${c.id}/history`);
    expect(h.map((e: any) => e.kind).slice(0, 2)).toEqual(['reviewed', 'rotated']);
    expect(h[1].comment).toBe('New password set in KeePass');
    const audit = await s.api('GET', `/audit?entityType=credential&entityId=${c.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['credential.created', 'credential.rotated', 'credential.reviewed']));
    const soon = await olivia('GET', '/credentials?dueWithinDays=70');
    expect(soon.items.map((x: any) => x.id)).toContain(c.id); // next rotation in 60 days
    expect((await olivia('GET', '/credentials?dueWithinDays=45')).items.map((x: any) => x.id)).not.toContain(c.id);
  });

  it('optimistic locking: an update with an old version is refused', async () => {
    const c = await dana('POST', '/credentials', entry());
    const { id, version, ...rest } = c;
    const body = { ...entry(), name: rest.name, version };
    await dana('PUT', `/credentials/${id}`, { ...body, description: 'first' });
    expect(await errorOf(dana('PUT', `/credentials/${id}`, { ...body, description: 'second' }))).toMatch(/VERSION_CONFLICT/);
  });
});

describe('permissions', () => {
  let id: string;
  beforeAll(async () => {
    id = (await dana('POST', '/credentials', entry({ name: 'Permission test entry', ownerSubjects: ['user:adam'] }))).id;
  });

  it('read: all roles but viewers; create/edit: admin, designer, operator', async () => {
    for (const c of [dana, olivia, adam, audrey]) expect((await c('GET', '/credentials')).items.some((x: any) => x.id === id)).toBe(true);
    expect((await vera('GET', '/credentials')).items).toEqual([]);
    expect(await status(vera('GET', `/credentials/${id}`))).toBe(404);
    expect((await adam('GET', '/credentials')).canCreate).toBe(false);
    expect((await audrey('GET', '/credentials')).canCreate).toBe(false);
    expect(await status(audrey('POST', '/credentials', entry()))).toBe(403);
    expect(await status(vera('POST', '/credentials', entry()))).toBe(403);
    expect(await status(audrey('PUT', `/credentials/${id}`, entry()))).toBe(403);
    expect(await status(audrey('POST', `/credentials/${id}/reviewed`, {}))).toBe(403);
  });

  it('a Steward user listed as owner may edit the entry (and must stay an owner)', async () => {
    const c = await adam('GET', `/credentials/${id}`);
    expect(c.permissions).toEqual(['view', 'edit']);
    await adam('POST', `/credentials/${id}/reviewed`, { comment: 'checked' });
    await adam('PUT', `/credentials/${id}`, entry({ name: 'Permission test entry', ownerSubjects: ['user:adam', 'team:service desk'] }));
    expect(await errorOf(adam('PUT', `/credentials/${id}`, entry({ name: 'Permission test entry', ownerSubjects: [] })))).toMatch(/OWNER_REQUIRED/);
  });

  it('a viewer who owns an entry sees only that one', async () => {
    const own = await dana('POST', '/credentials', entry({ name: 'Owned by vera', ownerSubjects: ['user:vera'] }));
    const list = (await vera('GET', '/credentials')).items;
    expect(list.map((x: any) => x.id)).toEqual([own.id]);
    expect((await vera('GET', `/credentials/${own.id}`)).permissions).toEqual(['view', 'edit']);
  });

  it('archive, restore and delete: administrators only', async () => {
    for (const c of [dana, olivia, adam]) {
      expect(await status(c('POST', `/credentials/${id}/archive`))).toBe(403);
      expect(await status(c('DELETE', `/credentials/${id}`))).toBe(403);
    }
    const a = await s.api('POST', `/credentials/${id}/archive`);
    expect(a.archived).toBe(true);
    expect((await dana('GET', '/credentials')).items.some((x: any) => x.id === id)).toBe(false);
    expect((await dana('GET', '/credentials?archived=only')).items.some((x: any) => x.id === id)).toBe(true);
    expect(await errorOf(dana('PUT', `/credentials/${id}`, entry()))).toMatch(/Archived/);
    await s.api('POST', `/credentials/${id}/restore`);
    await s.api('DELETE', `/credentials/${id}`);
    expect(await status(s.api('GET', `/credentials/${id}`))).toBe(404);
    expect((await s.api('GET', `/audit?action=credential.deleted`)).some((x: any) => x.entityId === id)).toBe(true);
  });

  it('reminder settings: everyone reads, administrators change', async () => {
    const st = await vera('GET', '/credentials/settings');
    expect(st).toMatchObject({ enabled: true, daysBefore: [30, 14, 7, 1], overdueEveryDays: 7 });
    expect(await status(dana('PUT', '/credentials/settings', st))).toBe(403);
    const changed = await s.api('PUT', '/credentials/settings', { ...st, daysBefore: [1, 14, 14, 60] });
    expect(changed.daysBefore).toEqual([60, 14, 1]);
    await s.api('PUT', '/credentials/settings', st);
  });
});

describe('reminders', () => {
  it('sends each reminder once (fake clock), re-arms on the next threshold and repeats overdue reminders', async () => {
    const { checkCredentialReminders } = await import('../src/credentials/reminders.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    await s.api('PUT', '/settings/notifications', {
      email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
      teams: { enabled: false },
      webhook: { enabled: false },
      routes: {},
    });
    const due = new Date(Date.now() + 20 * DAY).toISOString();
    const c = await dana(
      'POST',
      '/credentials',
      entry({
        name: 'Reminder test cert',
        expiresAt: due,
        ownerSubjects: ['user:olivia'],
        owners: [{ email: 'cert-owner@example.com', role: 'Business owner' }],
      }),
    );
    // only this entry: everything else in the register is archived for the test
    const { db } = await import('../src/db.js');
    db().run('UPDATE credentials SET archived = 1 WHERE id <> ?', c.id);
    mails.length = 0;
    const now = Date.now();
    expect(checkCredentialReminders(now)).toBe(1); // 30-day threshold reached
    expect(checkCredentialReminders(now)).toBe(0); // idempotent
    expect(checkCredentialReminders(now + DAY)).toBe(0);
    await flushNotifications();
    expect(mails.map((m) => m.to)).toEqual(['cert-owner@example.com']); // olivia has no e-mail address
    expect(mails[0]!.subject).toMatch(/Credential reminder: "Reminder test cert" – expiry due in 20 days/);
    const inbox = await olivia('GET', '/notifications');
    expect(inbox.items.filter((n: any) => n.title.startsWith('Credential reminder: "Reminder test cert"'))).toHaveLength(1);
    // 14 days before: the next reminder; 6 days before: the 7-day one
    expect(checkCredentialReminders(now + 6 * DAY + 3600000)).toBe(1);
    expect(checkCredentialReminders(now + 14 * DAY)).toBe(1);
    expect(checkCredentialReminders(now + 14 * DAY)).toBe(0);
    // overdue: once at the date, then every 7 days
    expect(checkCredentialReminders(now + 21 * DAY)).toBe(1);
    expect(checkCredentialReminders(now + 22 * DAY)).toBe(0);
    expect(checkCredentialReminders(now + 28 * DAY + 3600000)).toBe(1);
    // a restart does not resend: the claims are in the database
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM credential_reminders WHERE credential_id = ?', c.id)!.n).toBeGreaterThanOrEqual(5);
    // rotation with a new expiry re-arms the thresholds
    await dana('POST', `/credentials/${c.id}/rotated`, { expiresAt: new Date(now + 40 * DAY).toISOString() });
    expect(checkCredentialReminders(now + 15 * DAY)).toBe(1);
    // per-entry override: no reminders
    const fresh = await dana('GET', `/credentials/${c.id}`);
    await dana('PUT', `/credentials/${c.id}`, {
      ...entry({ name: fresh.name, expiresAt: fresh.expiresAt, ownerSubjects: ['user:olivia'] }),
      reminders: { disabled: true },
    });
    expect(checkCredentialReminders(now + 39 * DAY + 3600000)).toBe(0);
    const h = await dana('GET', `/credentials/${c.id}/history`);
    expect(h.filter((e: any) => e.kind === 'reminded').length).toBeGreaterThanOrEqual(6);
    db().run('UPDATE credentials SET archived = 0 WHERE id <> ?', c.id);
  });

  it('nothing is claimed while the vault is locked', async () => {
    const { checkCredentialReminders } = await import('../src/credentials/reminders.js');
    const { vault } = await import('../src/vault.js');
    const spy = vi.spyOn(vault(), 'unlocked', 'get').mockReturnValue(false);
    try {
      expect(checkCredentialReminders(Date.now() + 365 * DAY)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('export and public API', () => {
  it('CSV export respects permissions, escapes formulas and is audited', async () => {
    await dana('POST', '/credentials', entry({ name: '=HYPERLINK("http://evil")', tags: ['csv'] }));
    const cookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
    const res = await fetch(`${s.base}/api/credentials/export.csv?tag=csv`, { headers: { ...authHeaders(cookie), 'x-sm-client': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="credentials-/);
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('id,name,type,platform,environment,status,expires_at');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain('plant.manager@example.com (Business owner)');
    const veraCookie = await loginCookie(s.base, 'vera', PW);
    const v = await fetch(`${s.base}/api/credentials/export.csv?tag=csv`, { headers: { ...authHeaders(veraCookie), 'x-sm-client': '1' } });
    expect((await v.text()).trim().split('\r\n')).toHaveLength(1); // header only
    expect((await s.api('GET', '/audit?action=credential.exported')).length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/v1/credentials lists and gets entries with the token owner’s rights', async () => {
    const token = (await dana('POST', '/me/tokens', { name: 'credentials api', scope: 'read' })).token;
    const v1 = (url: string, t = token) => fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${t}` } });
    const res = await v1('/credentials?limit=2&archived=include');
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    expect(page.items[0]).not.toHaveProperty('permissions');
    expect(page.items[0]).toHaveProperty('location');
    const next = await (await v1(`/credentials?limit=2&archived=include&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
    expect(next.items[0].id).not.toBe(page.items[0].id);
    const one = await (await v1(`/credentials/${page.items[0].id}`)).json();
    expect(one.id).toBe(page.items[0].id);
    expect((await v1('/credentials/cred_nope')).status).toBe(404);
    const veraToken = (await vera('POST', '/me/tokens', { name: 'v', scope: 'read' })).token;
    expect((await (await v1('/credentials', veraToken)).json()).items.every((x: any) => x.ownerSubjects.includes('user:vera'))).toBe(true);
    expect((await v1(`/credentials/${page.items[0].id}`, veraToken)).status).toBe(404);
    expect((await v1('/credentials?status=bogus')).status).toBe(400);
  });

  it('the home page summary counts due soon, overdue and expired entries', async () => {
    await dana('POST', '/credentials', entry({ name: 'Expired thing', expiresAt: new Date(Date.now() - DAY).toISOString() }));
    const sum = await dana('GET', '/credentials/summary');
    expect(sum.expired).toBeGreaterThanOrEqual(1);
    expect(sum.items[0].status).toBe('expired');
    expect((await vera('GET', '/credentials/summary')).items.every((x: any) => x.ownerSubjects.includes('user:vera'))).toBe(true);
  });
});

describe('expiry sync from Gatus metrics', () => {
  it('updates "expires at" from the certificate gauge of the linked endpoint, audited', async () => {
    const gatusId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Gatus (demo)').id;
    await s.api('PUT', `/gatus/sources/${gatusId}`, { enabled: true, metricsPath: '/metrics' });
    await fetch(`${s.base}/mock/gatus/metrics/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'plant_mes-frontend', certificateDays: 12 }),
    });
    const c = await dana(
      'POST',
      '/credentials',
      entry({ type: 'certificate', name: 'MES TLS certificate', expiresAt: '2025-01-01', gatus: { platformId: gatusId, endpointKey: 'plant_mes-frontend' } }),
    );
    expect(await status(vera('POST', '/credentials', entry({ gatus: { platformId: gatusId, endpointKey: 'x' } })))).toBe(403);
    const hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    expect(await status(dana('POST', '/credentials', entry({ gatus: { platformId: hub, endpointKey: 'x' } })))).toBe(400);
    expect((await s.api('POST', `/gatus/sources/${gatusId}/scrape`)).ok).toBe(true);
    const after = await dana('GET', `/credentials/${c.id}`);
    expect(Math.abs(Date.parse(after.expiresAt) - (Date.now() + 12 * DAY))).toBeLessThan(3600000);
    expect(after.status).toBe('dueSoon');
    expect(after.updatedBy).toBe('system');
    const audit = await s.api('GET', `/audit?action=credential.expiry_synced`);
    expect(audit.some((a: any) => a.entityId === c.id && a.actor === 'system')).toBe(true);
    // a second scrape with the same expiry changes nothing
    await (await import('../src/gatus/metrics.js')).scrape(gatusId);
    expect((await dana('GET', `/credentials/${c.id}`)).version).toBe(after.version);
  });
});
