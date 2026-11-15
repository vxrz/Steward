import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The contacts of data products and the API of before 0.25.1 (ADR 0038 parts 1 and 2):
 *  - the old subject fields (`owners`, `owner`, `stewards`, a consumer's `contacts` as subjects) still work, but change
 *    only what they can express – the contacts linked to Steward users – so a client of before that reads an item and
 *    writes it back loses no contact;
 *  - naming `user:<name>` never tells anyone but administrators (and the account itself) the account's e-mail address;
 *  - a team's group contact is named as the team is written;
 *  - the internal API called with an API token gives contacts like /api/v1 – names and roles, no e-mail address or
 *    phone – and the consumers' contacts CSV is an export from the app (session only).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let dana: Client; // designer: changes the module's items
let tess: Client; // designer too: names others
let product = '';
let port = '';

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { status: number }).status, ...((e as { body: Record<string, unknown> }).body ?? {}) };
  }
  throw new Error('expected the call to fail');
};
type Link = { role: string; contact: { id: string; name: string; email?: string; phone?: string; user?: string | null } };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  for (const [username, roles, email] of [
    ['dana', ['designer'], 'dana@invented.example'],
    ['tess', ['designer'], 'tess@invented.example'],
    ['vera', ['viewer'], 'vera.secret@invented.example'],
  ] as const)
    users.createUser({ username, displayName: `Invented ${username}`, roles: [...roles], password: PW, mustChangePassword: false, email });
  await s.api('POST', '/teams', { name: 'Invented Finance Office', members: ['dana'] });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  tess = await s.as('tess', PW);
  product = (await dana('POST', '/data-products', { key: 'compat-orders', name: 'Compat orders' })).id;
  port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
}, 120_000);

describe('the old subject fields of the API', () => {
  it('change only the contacts linked to Steward users: what a client of before reads and writes back loses nothing', async () => {
    const office = (await dana('POST', '/contacts', { kind: 'group', name: 'Invented sales board', email: 'board@invented.example' })).id;
    const p = await dana('PUT', `/data-products/${product}`, {
      key: 'compat-orders',
      name: 'Compat orders',
      contacts: [
        { role: 'productOwner', contactId: office },
        { role: 'productOwner', contact: { name: 'Invented external owner', email: 'owner@supplier.invented.example' } },
        { role: 'businessContact', contact: { name: 'Invented analyst' } },
      ],
      owners: undefined,
    });
    expect(p.owners).toEqual([]);
    // a client of before adds dana with the old field: the other product owners stay
    const added = await dana('PUT', `/data-products/${product}`, { key: 'compat-orders', name: 'Compat orders', owners: ['user:dana'] });
    expect(added.owners).toEqual(['user:dana']);
    const names = (links: Link[]) => links.map((l) => `${l.role}: ${l.contact.name}`).sort();
    expect(names(added.contacts)).toEqual([
      'businessContact: Invented analyst',
      'productOwner: Invented dana',
      'productOwner: Invented external owner',
      'productOwner: Invented sales board',
    ]);
    // it writes back what it read (the description changed): nothing else changes, dana's contact is the same one
    const danaContact = (added.contacts as Link[]).find((l) => l.contact.user === 'dana')!.contact.id;
    const again = await dana('PUT', `/data-products/${product}`, { key: 'compat-orders', name: 'Compat orders', description: 'x', owners: added.owners });
    expect(names(again.contacts)).toEqual(names(added.contacts));
    expect((again.contacts as Link[]).find((l) => l.contact.user === 'dana')!.contact.id).toBe(danaContact);
    // and removes dana: only her
    const removed = await dana('PUT', `/data-products/${product}`, { key: 'compat-orders', name: 'Compat orders', owners: [] });
    expect(names(removed.contacts)).toEqual([
      'businessContact: Invented analyst',
      'productOwner: Invented external owner',
      'productOwner: Invented sales board',
    ]);
  });

  it('a data object’s owner and stewards, and a consumer’s contacts as subjects, the same way', async () => {
    const o = await dana('POST', '/data-objects', {
      key: 'compat-customer',
      name: 'Compat customer',
      contacts: [{ role: 'dataSteward', contact: { name: 'Invented steward without account' } }],
    });
    const changed = await dana('PUT', `/data-objects/${o.id}`, { key: 'compat-customer', name: 'Compat customer', owner: 'dana', stewards: [] });
    expect(changed.owner).toBe('dana');
    expect((changed.contacts as Link[]).map((l) => `${l.role}: ${l.contact.name}`).sort()).toEqual([
      'dataOwner: Invented dana',
      'dataSteward: Invented steward without account',
    ]);
    const url = `/data-products/${product}/ports/${port}/consumers`;
    const c = await dana('POST', url, {
      kind: 'text',
      text: 'Invented BI',
      contacts: [{ role: 'consumerContact', contact: { name: 'Invented BI lead', email: 'bi@invented.example' } }],
    });
    const after = await dana('PUT', `${url}/${c.id}`, { kind: 'text', text: 'Invented BI', contacts: ['user:dana'] });
    expect((after.contacts as Link[]).map((l) => l.contact.name).sort()).toEqual(['Invented BI lead', 'Invented dana']);
  });

  it('a team becomes a group contact named as the team is written', async () => {
    const d = await dana('POST', '/data-domains', { key: 'compat-finance', name: 'Compat finance', owners: ['team:invented finance office'] });
    expect((d.contacts as Link[]).map((l) => [l.role, l.contact.name])).toEqual([['domainOwner', 'Invented Finance Office']]);
  });
});

describe('personal data of accounts and the API token', () => {
  it('naming user:<name> tells nobody but administrators and the account itself its e-mail address', async () => {
    const own = await tess('POST', '/data-products', { key: 'compat-tess', name: 'Compat tess', owners: ['user:vera', 'user:tess'] });
    const byUser = new Map((own.contacts as Link[]).map((l) => [l.contact.user, l.contact]));
    expect(byUser.get('vera')).toMatchObject({ name: 'Invented vera', email: '' });
    expect(byUser.get('tess')).toMatchObject({ email: 'tess@invented.example' });
    // the contact page says no more
    expect((await tess('GET', `/contacts/${byUser.get('vera')!.id}`)).email).toBe('');
    // an administrator naming an account takes its address
    const adminMade = await s.api('POST', '/data-products', { key: 'compat-admin', name: 'Compat admin', owners: ['user:dana'] });
    expect((adminMade.contacts as Link[])[0]!.contact.email).toBe('dana@invented.example');
  });

  it('gives contacts by name and role to an API token on the internal API; the CSV is the app’s', async () => {
    const c = await dana('POST', `/data-products/${product}/ports/${port}/consumers`, {
      kind: 'text',
      text: 'Invented token check',
      contacts: [{ role: 'consumerContact', contact: { name: 'Invented reader lead', email: 'reader@invented.example', phone: '+49 30 555' } }],
    });
    await dana('PUT', `/data-products/${product}`, {
      key: 'compat-orders',
      name: 'Compat orders',
      contacts: [{ role: 'productOwner', contact: { name: 'Invented token owner', email: 'token.owner@invented.example', phone: '+49 30 556' } }],
    });
    const token = (await dana('POST', '/me/tokens', { name: 'compat', scope: 'read' })).token as string;
    const get = async (url: string) => {
      const res = await fetch(`${s.base}/api${url}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
    };
    const viaToken = await get(`/data-products/${product}`);
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.contacts).toEqual([
      { role: 'productOwner', contact: { id: expect.any(String), kind: 'person', name: 'Invented token owner', status: 'active', user: null } },
    ]);
    // the deprecated owners of /api/v1 still name the linked Steward users
    await dana('PUT', `/data-products/${product}`, { key: 'compat-orders', name: 'Compat orders', owners: ['user:dana'] });
    expect((await get(`/v1/data-products/${product}`)).body).toMatchObject({
      owners: ['user:dana'],
      // 0.26.0: with the role's label (ADR 0039)
      contacts: expect.arrayContaining([{ role: 'productOwner', roleLabel: 'Product owner', name: 'Invented dana' }]),
    });
    expect((await get(`/data-products/${product}`)).body.owners).toEqual(['user:dana']);
    // in the app: everything
    expect((await dana('GET', `/data-products/${product}`)).contacts[0].contact).toMatchObject({ email: 'token.owner@invented.example', phone: '+49 30 556' });
    const consumers = await get(`/data-products/${product}/ports/${port}/consumers`);
    const mine = (consumers.body as { id: string; contacts: Link[] }[]).find((x) => x.id === c.id)!;
    expect(mine.contacts[0]!.contact).not.toHaveProperty('email');
    expect(mine.contacts[0]!.contact).not.toHaveProperty('phone');
    const listed = await get(`/data-products/${product}/consumer-contacts`);
    expect(listed.body.withEmail).toBe(false);
    expect(JSON.stringify(listed.body)).not.toContain('reader@invented.example');
    expect((await get(`/data-products/${product}/consumer-contacts.csv`)).status).toBe(403);
    expect(await dana('GET', `/data-products/${product}/consumer-contacts.csv?lang=en`)).toContain('reader@invented.example');
    expect((await fail(dana('GET', '/contacts/nothing'))).status).toBe(404);
  });
});
