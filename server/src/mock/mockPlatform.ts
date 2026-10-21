import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-memory simulation of the parts of Insights Hub, Industrial Edge Management
 * and a web portal that the bundled templates use. Mounted at /mock in demo
 * mode so every feature can be tried without real credentials.
 */

const DEMO_CLIENT = { id: 'demo-client', secret: 'demo-secret' };
const DEMO_IEM_USER = { username: 'admin@example.com', password: 'demo-password' };

interface User {
  id: string;
  userName: string;
  name: { givenName: string; familyName: string };
  emails: { value: string }[];
  active: boolean;
  meta: { created: string; lastModified: string };
  lastLogonTime?: string;
}
interface Group {
  id: string;
  displayName: string;
  description: string;
  members: Set<string>;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
const uid = () => crypto.randomUUID();

function seed() {
  const people: [string, string, number | null][] = [
    ['Anna', 'Berger', 2],
    ['Bernd', 'Christ', 15],
    ['Clara', 'Dietz', 40],
    ['David', 'Engel', 95],
    ['Eva', 'Fuchs', 120],
    ['Felix', 'Graf', null],
    ['Greta', 'Hahn', 5],
    ['Hans', 'Ilg', 200],
    ['Ida', 'Jung', 61],
    ['Jonas', 'Kraus', 1],
    ['Karla', 'Lang', 380],
    ['Lukas', 'Maier', 33],
    ['Mia', 'Neumann', 91],
    ['Noah', 'Otto', null],
    ['Olga', 'Peters', 8],
  ];
  const users = new Map<string, User>();
  for (const [g, f, d] of people) {
    const u: User = {
      id: uid(),
      userName: `${g}.${f}@example.com`.toLowerCase(),
      name: { givenName: g, familyName: f },
      emails: [{ value: `${g}.${f}@example.com`.toLowerCase() }],
      active: true,
      meta: { created: daysAgo(400), lastModified: daysAgo(30) },
      ...(d === null ? {} : { lastLogonTime: daysAgo(d) }),
    };
    users.set(u.id, u);
  }
  const groups = new Map<string, Group>();
  const mk = (displayName: string, description: string, memberIdx: number[]) => {
    const all = [...users.values()];
    const g: Group = { id: uid(), displayName, description, members: new Set(memberIdx.map((i) => all[i]!.id)) };
    groups.set(g.id, g);
  };
  mk('mdsp:core:StandardUser', 'Standard user role', [...Array(people.length).keys()]);
  mk('mdsp:core:TenantAdmin', 'Tenant administrator', [0, 9]);
  mk('mdsp_usergroup:Operators', 'Plant operators', [1, 2, 3, 4, 6, 12]);
  mk('mdsp_usergroup:Engineers', 'Engineering', [0, 5, 7, 8, 10, 11]);
  mk('mdsp_usergroup:Viewers', 'Read only dashboards', [3, 13, 14]);
  mk('mdsp_usergroup:AccessReview', 'Users whose access is under review', []);

  // assets
  const v = (name: string, unit = '') => ({ name, dataType: 'DOUBLE', unit, searchable: true, qualityCode: true });
  const aspectTypes = {
    motor: { id: 'demo.MotorData', name: 'MotorData', variables: [v('speed', 'rpm'), v('current', 'A'), v('temperature', '°C'), v('vibration', 'mm/s'), v('torque', 'Nm')] },
    env: { id: 'demo.Environment', name: 'Environment', variables: [v('humidity', '%'), v('ambientTemp', '°C'), v('pressure', 'hPa')] },
    energy: { id: 'demo.Energy', name: 'Energy', variables: [v('activePower', 'kW'), v('reactivePower', 'kvar'), v('energy', 'kWh'), v('powerFactor')] },
  };
  const assetTypes = [
    { id: 'demo.Motor', name: 'Motor', variables: [v('ratedPower', 'kW')], aspects: [{ name: 'MotorData', aspectType: aspectTypes.motor }, { name: 'Energy', aspectType: aspectTypes.energy }] },
    { id: 'demo.Hall', name: 'Hall', variables: [], aspects: [{ name: 'Environment', aspectType: aspectTypes.env }] },
    { id: 'demo.Pump', name: 'Pump', variables: [v('ratedFlow', 'm3/h')], aspects: [{ name: 'MotorData', aspectType: aspectTypes.motor }] },
    { id: 'demo.LegacyCompressor', name: 'LegacyCompressor', variables: [v('serial')], aspects: [{ name: 'Energy', aspectType: aspectTypes.energy }] },
  ];
  const assets: { assetId: string; name: string; typeId: string; description: string }[] = [];
  const add = (name: string, typeId: string) => assets.push({ assetId: crypto.randomBytes(16).toString('hex'), name, typeId, description: '' });
  for (let i = 1; i <= 6; i++) add(`Motor M${i}`, 'demo.Motor');
  for (let i = 1; i <= 2; i++) add(`Hall ${i}`, 'demo.Hall');
  for (let i = 1; i <= 4; i++) add(`Pump P${i}`, 'demo.Pump');
  // time series: which variables have recent data, per asset+aspect
  const ts = new Map<string, Record<string, unknown>>();
  for (const a of assets) {
    const t = assetTypes.find((x) => x.id === a.typeId)!;
    for (const asp of t.aspects) {
      const vars = asp.aspectType.variables.map((x) => x.name);
      const idx = Number.parseInt(a.assetId.slice(0, 2), 16);
      // simulate: vibration/torque/reactivePower rarely used, some assets silent
      const used = vars.filter((n) => !['torque', 'reactivePower', 'powerFactor'].includes(n) && !(n === 'vibration' && idx % 2));
      if (a.name === 'Pump P4') continue; // no data at all
      const rec: Record<string, unknown> = { _time: daysAgo(asp.name === 'Energy' && idx % 3 === 0 ? 45 : 0.01) };
      for (const n of used) rec[n] = Math.round(Math.random() * 1000) / 10;
      ts.set(`${a.assetId}/${asp.name}`, rec);
    }
  }
  const devices = [
    { id: 'dev-001', name: 'edge-line-1', deviceStatus: 'ACTIVE', connectionState: 'ONLINE', lastSeen: daysAgo(0.001), firmware: '2.4.0' },
    { id: 'dev-002', name: 'edge-line-2', deviceStatus: 'ACTIVE', connectionState: 'ONLINE', lastSeen: daysAgo(0.002), firmware: '2.4.0' },
    { id: 'dev-003', name: 'edge-paint-shop', deviceStatus: 'ACTIVE', connectionState: 'OFFLINE', lastSeen: daysAgo(3), firmware: '2.1.3' },
    { id: 'dev-004', name: 'edge-warehouse', deviceStatus: 'ACTIVE', connectionState: 'ONLINE', lastSeen: daysAgo(0.01), firmware: '1.9.0' },
    { id: 'dev-005', name: 'edge-lab', deviceStatus: 'INACTIVE', connectionState: 'OFFLINE', lastSeen: daysAgo(40), firmware: '2.4.0' },
  ];
  return { users, groups, assetTypes, assets, ts, devices };
}

export async function mockPlatform(app: FastifyInstance): Promise<void> {
  let state = seed();
  const tokens = new Set<string>();
  const iemTokens = new Set<string>();

  app.post('/reset', async () => {
    state = seed();
    return { ok: true };
  });

  // ---------------- Insights Hub ----------------
  app.post('/ih/oauth/token', async (req, reply) => {
    const auth = String(req.headers.authorization ?? '');
    const [id, secret] = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
    if (id !== DEMO_CLIENT.id || secret !== DEMO_CLIENT.secret) return reply.code(401).send({ error: 'invalid_client' });
    const t = crypto.randomBytes(24).toString('hex');
    tokens.add(t);
    return { access_token: t, token_type: 'bearer', expires_in: 1799 };
  });

  const ihAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokens.has(t)) return reply.code(401).send({ error: 'unauthorized' });
  };

  const scimFilter = (filter: string | undefined, obj: Record<string, unknown>): boolean => {
    if (!filter) return true;
    const m = /^\s*(\w+(?:\.\w+)?)\s+(eq|sw|co)\s+"([^"]*)"\s*$/i.exec(filter);
    if (!m) return true;
    const [, attr, op, val] = m;
    const actual = String(attr!.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj) ?? '').toLowerCase();
    const v = val!.toLowerCase();
    return op!.toLowerCase() === 'eq' ? actual === v : op!.toLowerCase() === 'sw' ? actual.startsWith(v) : actual.includes(v);
  };

  const userView = (u: User) => ({
    ...u,
    groups: [...state.groups.values()].filter((g) => g.members.has(u.id)).map((g) => ({ display: g.displayName, value: g.id, type: 'DIRECT' })),
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  });
  const groupView = (g: Group) => ({ id: g.id, displayName: g.displayName, description: g.description, members: [...g.members].map((m) => ({ type: 'USER', value: m })) });

  const page = <T>(all: T[], q: Record<string, string>) => {
    const start = Math.max(1, Number(q.startIndex ?? 1));
    const count = Math.min(Math.max(1, Number(q.count ?? 100)), 500);
    const slice = all.slice(start - 1, start - 1 + count);
    return { resources: slice, totalResults: all.length, itemsPerPage: slice.length, startIndex: start, schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'] };
  };

  const IDM = '/ih/api/identitymanagement/v3';
  app.get(`${IDM}/Users`, { preHandler: ihAuth }, async (req) => {
    const q = req.query as Record<string, string>;
    const all = [...state.users.values()].map(userView).filter((u) => scimFilter(q.filter, u as never));
    return page(all, q);
  });
  app.get(`${IDM}/Users/:id`, { preHandler: ihAuth }, async (req, reply) => {
    const u = state.users.get((req.params as { id: string }).id);
    return u ? userView(u) : reply.code(404).send({ error: 'not found' });
  });
  app.post(`${IDM}/Users`, { preHandler: ihAuth }, async (req, reply) => {
    const b = req.body as Partial<User>;
    if (!b?.userName) return reply.code(400).send({ error: 'userName required' });
    if ([...state.users.values()].some((u) => u.userName === b.userName!.toLowerCase())) return reply.code(409).send({ error: 'exists' });
    const u: User = {
      id: uid(),
      userName: b.userName.toLowerCase(),
      name: { givenName: b.name?.givenName ?? '', familyName: b.name?.familyName ?? '' },
      emails: [{ value: b.userName.toLowerCase() }],
      active: true,
      meta: { created: new Date().toISOString(), lastModified: new Date().toISOString() },
    };
    state.users.set(u.id, u);
    state.groups.forEach((g) => g.displayName === 'mdsp:core:StandardUser' && g.members.add(u.id));
    return reply.code(201).send(userView(u));
  });
  app.delete(`${IDM}/Users/:id`, { preHandler: ihAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!state.users.delete(id)) return reply.code(404).send({ error: 'not found' });
    state.groups.forEach((g) => g.members.delete(id));
    return reply.code(200).send(userView({ id } as User));
  });
  app.get(`${IDM}/Groups`, { preHandler: ihAuth }, async (req) => {
    const q = req.query as Record<string, string>;
    return page([...state.groups.values()].map(groupView).filter((g) => scimFilter(q.filter, g as never)), q);
  });
  app.get(`${IDM}/Groups/:id/members`, { preHandler: ihAuth }, async (req, reply) => {
    const g = state.groups.get((req.params as { id: string }).id);
    return g ? [...g.members].map((m) => ({ type: 'USER', value: m })) : reply.code(404).send({ error: 'not found' });
  });
  app.post(`${IDM}/Groups/:id/members`, { preHandler: ihAuth }, async (req, reply) => {
    const g = state.groups.get((req.params as { id: string }).id);
    const b = req.body as { type?: string; value?: string };
    if (!g) return reply.code(404).send({ error: 'group not found' });
    if (!b?.value || !state.users.has(b.value)) return reply.code(400).send({ error: 'unknown member' });
    if (g.members.has(b.value)) return reply.code(409).send({ error: 'already member' });
    g.members.add(b.value);
    return reply.code(201).send({ type: 'USER', value: b.value });
  });
  app.delete(`${IDM}/Groups/:id/members/:mid`, { preHandler: ihAuth }, async (req, reply) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const g = state.groups.get(id);
    if (!g || !g.members.delete(mid)) return reply.code(404).send({ error: 'not a member' });
    return reply.code(200).send({ type: 'USER', value: mid });
  });

  const AM = '/ih/api/assetmanagement/v3';
  const pageOf = <T>(key: string, all: T[], q: Record<string, string>) => {
    const size = Math.max(1, Number(q.size ?? 10));
    const number = Number(q.page ?? 0);
    return {
      _embedded: { [key]: all.slice(number * size, number * size + size) },
      page: { size, totalElements: all.length, totalPages: Math.ceil(all.length / size), number },
    };
  };
  app.get(`${AM}/assets`, { preHandler: ihAuth }, async (req) => pageOf('assets', state.assets, req.query as Record<string, string>));
  app.get(`${AM}/assettypes`, { preHandler: ihAuth }, async (req) => pageOf('assetTypes', state.assetTypes, req.query as Record<string, string>));
  app.get('/ih/api/iottimeseries/v3/timeseries/:entity/:aspect', { preHandler: ihAuth }, async (req) => {
    const { entity, aspect } = req.params as { entity: string; aspect: string };
    const rec = state.ts.get(`${entity}/${aspect}`);
    return rec ? [rec] : [];
  });

  // ---------------- Industrial Edge Management ----------------
  app.post('/iem/portal/api/v1/login/direct', async (req, reply) => {
    const b = req.body as { username?: string; password?: string };
    if (b?.username !== DEMO_IEM_USER.username || b?.password !== DEMO_IEM_USER.password) {
      return reply.code(401).send({ errors: [{ message: 'Invalid credentials' }] });
    }
    const t = crypto.randomBytes(24).toString('hex');
    iemTokens.add(t);
    return { data: { access_token: t, expires_in: Math.floor(Date.now() / 1000) + 86400 } };
  });
  const iemAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!iemTokens.has(t)) return reply.code(401).send({ errors: [{ message: 'unauthorized' }] });
  };
  app.get('/iem/portal/api/v1/devices', { preHandler: iemAuth }, async () => ({ data: state.devices, page: { totalElements: state.devices.length } }));
  app.get('/iem/portal/api/v1/applications', { preHandler: iemAuth }, async () => ({
    data: [
      { applicationId: 'app-1', title: 'Data Service', version: '1.8.0' },
      { applicationId: 'app-2', title: 'IE Databus', version: '2.1.0' },
    ],
  }));

  // ---------------- Web portal (browser automation demo) ----------------
  const html = (body: string) =>
    `<!doctype html><html><head><title>Demo Portal</title><style>body{font-family:sans-serif;margin:40px}input{display:block;margin:6px 0 12px;padding:6px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}</style></head><body>${body}</body></html>`;
  app.get('/portal/login', async (_req, reply) =>
    reply.type('text/html').send(
      html(`<h1>Demo Portal – Sign in</h1><form method="post" action="/mock/portal/login">
<label>E-mail<input id="email" name="email"/></label><label>Password<input id="password" type="password" name="password"/></label>
<button id="signin" type="submit">Sign in</button></form>`),
    ),
  );
  app.post('/portal/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string };
    if (b?.email === DEMO_IEM_USER.username && b?.password === DEMO_IEM_USER.password) {
      return reply.header('set-cookie', 'demo_session=1; Path=/mock/portal; HttpOnly').redirect('/mock/portal/home');
    }
    return reply.type('text/html').code(401).send(html('<h1>Sign in failed</h1><p class="error">Invalid credentials</p>'));
  });
  app.get('/portal/home', async (req, reply) => {
    if (!String(req.headers.cookie ?? '').includes('demo_session=1')) return reply.redirect('/mock/portal/login');
    const offline = state.devices.filter((d) => d.connectionState !== 'ONLINE').length;
    return reply.type('text/html').send(
      html(`<h1>Welcome, Admin</h1><p id="system-status">System status: ${offline ? 'Degraded' : 'Operational'}</p>
<p>License usage: <span id="license-usage">72%</span></p>
<table><tr><th>Device</th><th>State</th></tr>${state.devices.map((d) => `<tr><td>${d.name}</td><td class="state">${d.connectionState}</td></tr>`).join('')}</table>`),
    );
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
}

export const DEMO_CREDENTIALS = { client: DEMO_CLIENT, iem: DEMO_IEM_USER };
