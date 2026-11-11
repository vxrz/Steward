import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { PLANT_PROPOSAL_LIMITS } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * 0.17.0: plant proposals in parts and sources of data points. An assistant sends a document of the import format in
 * parts (`more: true`, then `proposalId`); Steward combines them – entries merged by key, lists by their ids, a value
 * given differently refused – and previews the combined document with the last part. Until then nobody reviews it, no
 * reviewer is told, and it expires a day after its last part; its owner can withdraw it. Data points carry a `source`
 * (a document and the page): in the format and its export, the MCP answers and the review, which says whether that
 * document is kept in Steward.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
let dana: Client, olaf: Client;
const tok: Record<string, string> = {};
const MODERN = '2026-07-28';
let nextId = 1;
const MANUAL = 'C80 Operating Manual v4';

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': MODERN,
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const body = JSON.parse(text);
  if (body.error) return { isError: true, data: body.error.message };
  return { isError: !!body.result.isError, data: body.result.isError ? body.result.content[0].text : body.result.structuredContent };
}
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const db = async () => (await import('../src/db.js')).db();
const auditActions = async (entityId: string) =>
  (await db()).all<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY seq', entityId).map((r) => r.action);
const auditDetails = async (entityId: string, action: string) =>
  (await db())
    .all<{ details: string }>('SELECT details FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY seq', entityId, action)
    .map((r) => JSON.parse(r.details));
const told = async (c: Client, id: string) =>
  ((await c('GET', '/notifications')).items as any[]).some((n) => n.event === 'mcp.request' && n.link === `/mcp-requests/${id}`);
const propose = (args: Record<string, unknown>, token = tok.dana!) =>
  call(token, 'propose_plant_changes', { title: 'C80 from its manual', rationale: `Read from the ${MANUAL} (example)`, ...args });

/** A data point as a manual describes it, with its source. */
const point = (id: string, page: number | string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.replace(/_/g, ' '),
  data_type: 'Double',
  address: `ns=3;s=/C80/${id}`,
  source: { document: MANUAL, page, section: '6.3 OPC UA variables' },
  ...extra,
});
/** A part with a device profile: its id and name always (each part is a document by itself), and some groups. */
const profilePart = (id: string, groups: { name: string; data_points: unknown[] }[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  device_profile: {
    id,
    name: `Example Controls C80 (${id})`,
    manufacturer: 'Example Controls',
    interfaces: [{ id: 'opc-ua', protocol: 'opc_ua', groups }],
    ...extra,
  },
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'olaf', roles: ['designer'], password: PW });
  [dana, olaf] = await Promise.all(['dana', 'olaf'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  tok.dana = (await dana('POST', '/me/tokens', { name: 'mcp dana', scope: 'mcp' })).token;
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North works' });
  await s.api('POST', '/plant/assets', { id: 'north-gw-1', siteId: 'north', name: 'Gateway 1' });
});
afterAll(async () => {
  await s?.app.close();
});

describe('proposals in parts', () => {
  let id = '';
  it('keeps the parts of an unfinished proposal: nobody reviews it, no reviewer is told, the problems so far are answered', async () => {
    // the assignment first: the profile it names comes with a later part – a problem so far, the part is kept
    const one = await propose({
      more: true,
      document: {
        version: 1,
        assignment: { asset: 'north-gw-1', profile: 'example-c80', interfaces: [{ interface: 'opc-ua', endpoint: 'opc.tcp://north-gw-1.example.com:4840' }] },
      },
    });
    expect(one.isError, one.data).toBe(false);
    expect(one.data).toMatchObject({ status: 'incomplete', part: 1, proposalId: expect.stringMatching(/^mrq_/), dropsSoFar: [] });
    expect(one.data.problemsSoFar.join(' ')).toMatch(/example-c80/);
    id = one.data.proposalId;
    // a day to send the next part
    const hours = (Date.parse(one.data.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(PLANT_PROPOSAL_LIMITS.partExpiryHours);
    const two = await propose({
      proposalId: id,
      more: true,
      document: profilePart('example-c80', [{ name: 'State', data_points: [point('run_state', 101), point('alarm_count', 102)] }]),
    });
    expect(two.isError, two.data).toBe(false);
    expect(two.data).toMatchObject({ status: 'incomplete', part: 2, problemsSoFar: [] });
    // the same entry again, with a data point more in a group of the second part and a group more
    const three = await propose({
      proposalId: id,
      more: true,
      document: profilePart('example-c80', [
        { name: 'State', data_points: [point('alarm_count', 102), point('door_open', 103, { data_type: 'Boolean' })] },
        { name: 'Spindle', data_points: [point('spindle_speed', 112, { unit: '/min' })] },
      ]),
    });
    expect(three.isError, three.data).toBe(false);
    expect(three.data).toMatchObject({ status: 'incomplete', part: 3, problemsSoFar: [] });
    // nobody but its owner sees it; it is not in the inbox of who decides, and nobody is told
    expect(await status(olaf('GET', `/mcp-requests/${id}`))).toEqual({ status: 404, code: 'MCP_REQUEST_NOT_FOUND' });
    expect((await olaf('GET', '/mcp-requests?scope=decide')).map((r: any) => r.id)).not.toContain(id);
    expect(await told(olaf, id)).toBe(false);
    const mine = await dana('GET', `/mcp-requests/${id}`);
    expect(mine).toMatchObject({ status: 'pending', canApprove: false, canReject: true, proposal: { type: 'plant', incomplete: true, parts: 3 } });
    expect(mine.proposal.changeSetId).toBeNull();
    // no change set yet: Plant → Changes does not list it
    expect((await s.api('GET', '/plant/change-sets?box=review')).items.map((c: any) => c.mcpRequestId)).not.toContain(id);
    expect((await call(tok.dana, 'get_operation_request', { requestId: id })).data).toMatchObject({
      status: 'pending',
      what: expect.stringMatching(/3 part\(s\) so far/),
    });
  });

  it('combines the parts with the last one: one preview, one change set, the reviewers told only now', async () => {
    const last = await propose({
      proposalId: id,
      document: profilePart('example-c80', [{ name: 'Spindle', data_points: [point('spindle_load', 113, { unit: '%' })] }]),
    });
    expect(last.isError, last.data).toBe(false);
    expect(last.data).toMatchObject({ status: 'pending', requestId: id, added: 2, changed: 0, parts: 4 });
    const days = (Date.parse(last.data.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    await vi.waitFor(async () => expect(await told(olaf, id)).toBe(true));
    const detail = await olaf('GET', `/mcp-requests/${id}`);
    expect(detail).toMatchObject({ canApprove: true, proposal: { incomplete: false, parts: 4, changeSetId: expect.any(String) } });
    expect(detail.proposal.proposed.changes.map((c: any) => `${c.kind}:${c.action}:${c.id}`).sort()).toEqual([
      'assignment:add:north-gw-1',
      'profile:add:example-c80',
    ]);
    // the parts as one document: groups and data points merged by their ids, in the order they came
    const cs = await s.api('GET', `/plant/change-sets/${detail.proposal.changeSetId}`);
    expect(cs).toMatchObject({ state: 'proposed', source: 'assistant' });
    const src = (await db()).get<{ content: string }>('SELECT content FROM plant_change_sources WHERE change_set_id = ?', detail.proposal.changeSetId)!;
    const doc = JSON.parse(src.content);
    expect(doc.device_profiles).toHaveLength(1);
    expect(doc.device_profiles[0].interfaces[0].groups.map((g: any) => [g.name, g.data_points.map((d: any) => d.id)])).toEqual([
      ['State', ['run_state', 'alarm_count', 'door_open']],
      ['Spindle', ['spindle_speed', 'spindle_load']],
    ]);
    expect(doc.assignments).toEqual([expect.objectContaining({ asset: 'north-gw-1' })]);
    // where the data points come from: the profile is new, its manual is attached once it is applied
    expect(detail.proposal.sources).toEqual([
      expect.objectContaining({
        kind: 'profile',
        entry: 'example-c80',
        exists: false,
        document: MANUAL,
        record: null,
        points: expect.arrayContaining([
          { interface: 'opc-ua', group: 'Spindle', id: 'spindle_speed', name: 'spindle speed', action: 'add', page: '112', section: '6.3 OPC UA variables' },
        ]),
      }),
    ]);
    expect(detail.proposal.sources[0].points).toHaveLength(5);
    expect(await auditActions(id)).toEqual([
      'mcp.request_created',
      'plant.proposal_part_received',
      'plant.proposal_part_received',
      'plant.proposal_part_received',
      'plant.proposal_part_received',
      'mcp.proposal_completed',
      'plant.proposal_created',
    ]);
    expect((await auditDetails(id, 'plant.proposal_part_received')).map((d) => [d.part, d.last])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    expect((await auditDetails(id, 'plant.proposal_created'))[0]).toMatchObject({ parts: 4, counts: { add: 2, change: 0 } });
    // the parts themselves are not kept with the request any more
    const payload = JSON.parse((await db()).get<{ payload: string }>('SELECT payload FROM mcp_requests WHERE id = ?', id)!.payload);
    expect(payload).toEqual({ type: 'plant', title: 'C80 from its manual', incomplete: false, added: 2, changed: 0, parts: 4 });
    // a complete proposal takes no further part
    expect((await propose({ proposalId: id, document: profilePart('example-c80', []) })).data).toMatch(/complete already/);
  });

  it('is applied as one: the data points keep their sources – in the profile, its export and the MCP answers', async () => {
    const done = await olaf('POST', `/mcp-requests/${id}/decision`, { approve: true, comment: 'Checked against the manual' });
    expect(done).toMatchObject({ status: 'done', resultBody: { added: 2, changed: 0 } });
    const p = await s.api('GET', '/plant/profiles/example-c80');
    const speed = p.interfaces[0].groups[1].dataPoints.find((d: any) => d.id === 'spindle_speed');
    expect(speed.source).toEqual({ document: MANUAL, page: '112', section: '6.3 OPC UA variables' });
    const exported = YAML.parse(await s.api('GET', '/plant/export?profile=example-c80'));
    expect(exported.device_profile.interfaces[0].groups[1].data_points[0]).toMatchObject({
      id: 'spindle_speed',
      source: { document: MANUAL, page: '112', section: '6.3 OPC UA variables' },
    });
    const viaMcp = (await call(tok.dana, 'get_device_profile', { profileId: 'example-c80' })).data;
    expect(viaMcp.interfaces[0].groups[1].dataPoints[0]).toMatchObject({ id: 'spindle_speed', source: { document: MANUAL, page: '112' } });
    expect(viaMcp.file.interfaces[0].groups[1].data_points[0].source).toEqual({ document: MANUAL, page: '112', section: '6.3 OPC UA variables' });
    const one = (await call(tok.dana, 'get_data_point', { profileId: 'example-c80', pointId: 'door_open' })).data;
    expect(one.dataPoint.source).toEqual({ document: MANUAL, page: '103', section: '6.3 OPC UA variables' });
  });

  it('refuses a part that does not combine, is no document by itself, is too large or holds a credential – the parts so far stay', async () => {
    const first = await propose({ more: true, document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('x_pos', 120, { unit: 'mm' })] }]) });
    expect(first.isError, first.data).toBe(false);
    const pid = first.data.proposalId;
    // the same data point with another unit
    const unit = await propose({
      proposalId: pid,
      more: true,
      document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('x_pos', 120, { unit: 'cm' })] }]),
    });
    expect(unit).toMatchObject({
      isError: true,
      data: expect.stringMatching(/Part 2 does not combine[\s\S]*data_points\[x_pos\]\.unit: part 2 gives "cm", an earlier part "mm"/),
    });
    // a list without ids, given differently
    const pubs = (path: string) =>
      profilePart('example-c80', [{ name: 'Axes', data_points: [point('x_pos', 120, { unit: 'mm', publications: [{ target: 'iot', path }] })] }]);
    expect((await propose({ proposalId: pid, more: true, document: pubs('a') })).isError).toBe(false);
    expect(await propose({ proposalId: pid, more: true, document: pubs('b') })).toMatchObject({
      isError: true,
      data: expect.stringMatching(/publications: part 3 gives this list differently .* no ids/),
    });
    // a name of the profile left out: no document of the format by itself
    expect(await propose({ proposalId: pid, more: true, document: { version: 1, device_profile: { id: 'example-c80', interfaces: [] } } })).toMatchObject({
      isError: true,
      data: expect.stringMatching(/no document of the import format[\s\S]*device_profile\.name: Required/),
    });
    expect(await propose({ proposalId: pid, more: true, document: { ...profilePart('example-c80', []), padding: 'x'.repeat(50_000) } })).toMatchObject({
      isError: true,
      data: expect.stringMatching(/This part is too large/),
    });
    const secret = await propose({
      proposalId: pid,
      more: true,
      document: {
        version: 1,
        assignment: { asset: 'north-gw-1', interfaces: [{ interface: 'opc-ua', endpoint: 'opc.tcp://ops:s3cret@gw.example.com:4840' }] },
      },
    });
    expect(secret).toMatchObject({
      isError: true,
      data: expect.stringMatching(/This part holds what looks like a credential[\s\S]*assignment\.interfaces\[0\]\.endpoint/),
    });
    // what is the same in two parts is fine; a later part brings what an earlier one lacks
    const same = await propose({ proposalId: pid, more: true, document: pubs('a') });
    expect(same.isError, same.data).toBe(false);
    expect(same.data.part).toBe(3);
    expect((await dana('GET', `/mcp-requests/${pid}`)).proposal.parts).toBe(3);
    await dana('POST', `/mcp-requests/${pid}/decision`, { approve: false, comment: '' });
  });

  it('holds at most so many parts, and so many bytes together', async () => {
    const limits = PLANT_PROPOSAL_LIMITS as { parts: number; totalBytes: number };
    const { parts, totalBytes } = limits;
    try {
      limits.parts = 2;
      const a = await propose({ more: true, document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('y_pos', 121)] }]) });
      expect(
        (
          await propose({
            proposalId: a.data.proposalId,
            more: true,
            document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('z_pos', 122)] }]),
          })
        ).isError,
      ).toBe(false);
      expect(await propose({ proposalId: a.data.proposalId, document: profilePart('example-c80', []) })).toMatchObject({
        isError: true,
        data: expect.stringMatching(/at most 2 parts/),
      });
      await dana('POST', `/mcp-requests/${a.data.proposalId}/decision`, { approve: false, comment: '' });
      limits.parts = parts;
      limits.totalBytes = 3000;
      const b = await propose({
        more: true,
        document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('y_pos', 121, { notes: 'n'.repeat(1500) })] }]),
      });
      expect(b.isError, b.data).toBe(false);
      expect(
        await propose({
          proposalId: b.data.proposalId,
          more: true,
          document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('z_pos', 122, { notes: 'm'.repeat(1500) })] }]),
        }),
      ).toMatchObject({ isError: true, data: expect.stringMatching(/parts together would be too large/) });
      await dana('POST', `/mcp-requests/${b.data.proposalId}/decision`, { approve: false, comment: '' });
    } finally {
      limits.parts = parts;
      limits.totalBytes = totalBytes;
    }
  });

  it('keeps the rule of only adding and changing on the combined document', async () => {
    // the profile has run_state, alarm_count and door_open in State: a part that lists only run_state would drop two …
    const first = await propose({ more: true, document: profilePart('example-c80', [{ name: 'State', data_points: [point('run_state', 101)] }]) });
    expect(first.isError, first.data).toBe(false);
    expect(first.data.dropsSoFar.join(' ')).toMatch(/would lose .*alarm_count/);
    const pid = first.data.proposalId;
    // … a last part without them is refused, nothing is proposed, the parts stay …
    const lost = await propose({
      proposalId: pid,
      document: profilePart('example-c80', [
        { name: 'Spindle', data_points: [point('spindle_speed', 112, { unit: '/min' }), point('spindle_load', 113, { unit: '%' })] },
      ]),
    });
    expect(lost).toMatchObject({ isError: true, data: expect.stringMatching(/never drop one[\s\S]*would lose .*alarm_count/) });
    expect((await dana('GET', `/mcp-requests/${pid}`)).proposal).toMatchObject({ incomplete: true, parts: 1 });
    // … and a last part that brings them back (with a new data point) is proposed
    const ok = await propose({
      proposalId: pid,
      document: profilePart('example-c80', [
        {
          name: 'State',
          data_points: [point('alarm_count', 102), point('door_open', 103, { data_type: 'Boolean' }), point('mode', 104, { data_type: 'Int32' })],
        },
        { name: 'Spindle', data_points: [point('spindle_speed', 112, { unit: '/min' }), point('spindle_load', 113, { unit: '%' })] },
      ]),
    });
    expect(ok.isError, ok.data).toBe(false);
    expect(ok.data).toMatchObject({ added: 0, changed: 1, parts: 2 });
    const detail = await olaf('GET', `/mcp-requests/${pid}`);
    // only what it adds or changes is listed with its source; the profile exists, its manual is not kept yet
    expect(detail.proposal.sources).toEqual([
      expect.objectContaining({
        entry: 'example-c80',
        exists: true,
        record: null,
        points: [expect.objectContaining({ id: 'mode', action: 'add', page: '104' })],
      }),
    ]);
    // a record linked to the profile with the manual's title is the document
    const rec = await s.api('POST', '/records', { type: 'DOC', title: MANUAL, links: [{ kind: 'device-profile', id: 'example-c80', note: '' }] });
    expect((await olaf('GET', `/mcp-requests/${pid}`)).proposal.sources[0].record).toEqual({ id: rec.id, number: rec.number, title: MANUAL });
    await olaf('POST', `/mcp-requests/${pid}/decision`, { approve: false, comment: 'Later' });
  });

  it('an unfinished proposal is withdrawn by its owner, or expires a day after its last part – its parts are not kept', async () => {
    const a = await propose({ more: true, document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('a_pos', 130)] }]) });
    const withdrawn = await dana('POST', `/mcp-requests/${a.data.proposalId}/decision`, { approve: false, comment: 'Wrong manual' });
    expect(withdrawn.status).toBe('withdrawn');
    expect(await auditActions(a.data.proposalId)).toEqual([
      'mcp.request_created',
      'plant.proposal_part_received',
      'plant.proposal_rejected',
      'mcp.request_withdrawn',
    ]);
    expect((await auditDetails(a.data.proposalId, 'plant.proposal_rejected'))[0]).toMatchObject({ withdrawn: true, unfinished: true, parts: 1 });
    const kept = async (rid: string) => JSON.parse((await db()).get<{ payload: string }>('SELECT payload FROM mcp_requests WHERE id = ?', rid)!.payload);
    expect(await kept(a.data.proposalId)).toMatchObject({ incomplete: true, parts: 1 });
    expect((await kept(a.data.proposalId)).documents).toBeUndefined();
    expect((await dana('GET', `/mcp-requests/${a.data.proposalId}`)).proposal).toMatchObject({ incomplete: false, unfinished: true, parts: 1 });
    expect(await told(olaf, a.data.proposalId)).toBe(false);

    const b = await propose({ more: true, document: profilePart('example-c80', [{ name: 'Axes', data_points: [point('b_pos', 131)] }]) });
    const { expireRequests } = await import('../src/mcp/requests.js');
    expireRequests(new Date(Date.now() + 25 * 3_600_000).toISOString());
    expect((await dana('GET', `/mcp-requests/${b.data.proposalId}`)).status).toBe('expired');
    expect((await kept(b.data.proposalId)).documents).toBeUndefined();
    expect(await propose({ proposalId: b.data.proposalId, document: profilePart('example-c80', []) })).toMatchObject({
      isError: true,
      data: expect.stringMatching(/not found, or it is no longer open/),
    });
    expect(await told(olaf, b.data.proposalId)).toBe(false);
  });
});

describe('combining parts with keys of the prototype (security review 0.17.0)', () => {
  it('matches keys as the part’s own: a key such as toString combines like any other', async () => {
    const { combineParts } = await import('../src/plant/proposal-parts.js');
    const a = { version: 1, device_profile: { id: 'p', name: 'P', labels: { toString: 'x', hasOwnProperty: 'y' } } };
    const b = { version: 1, device_profile: { id: 'p', name: 'P', labels: { toString: 'x', valueOf: 'z' } } };
    expect(combineParts([a, b])).toEqual({
      version: 1,
      device_profiles: [{ id: 'p', name: 'P', labels: { toString: 'x', hasOwnProperty: 'y', valueOf: 'z' } }],
    });
  });

  it('refuses a part with a key __proto__, constructor or prototype anywhere, with a clear message', async () => {
    const { combineParts, PartKeyRefused } = await import('../src/plant/proposal-parts.js');
    const ok = { version: 1, device_profile: { id: 'p', name: 'P' } };
    // JSON.parse makes __proto__ an own key, as the parts arrive
    const proto = JSON.parse('{"version":1,"device_profile":{"id":"p","name":"P","labels":{"__proto__":{"polluted":true}}}}');
    expect(() => combineParts([ok, proto])).toThrow(PartKeyRefused);
    expect(() => combineParts([ok, proto])).toThrow(/device_profile\.labels\.__proto__: part 2 has the key "__proto__"/);
    for (const key of ['constructor', 'prototype']) {
      const bad = JSON.parse(`{"version":1,"device_profile":{"id":"p","name":"P","interfaces":[{"id":"i","${key}":{"x":1}}]}}`);
      expect(() => combineParts([bad]), key).toThrow(new RegExp(`device_profile\\.interfaces\\[0\\]\\.${key}: part 1 has the key "${key}"`));
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // the format's own check refuses such a key where the format names its fields; combineParts refuses it everywhere
  it('answers the assistant that the part was not kept', async () => {
    const first = await propose({ more: true, document: profilePart('proto-c80', [{ name: 'Axes', data_points: [point('x_pos', 1)] }]) });
    expect(first.isError, first.data).toBe(false);
    const doc = JSON.parse(JSON.stringify(profilePart('proto-c80', [{ name: 'Axes', data_points: [point('y_pos', 2)] }])));
    doc.device_profile.interfaces[0].groups[0].data_points[0].constructor = { name: 'x' };
    const refused = await propose({ proposalId: first.data.proposalId, more: true, document: doc });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatch(/not kept[\s\S]*"constructor"/);
    await dana('POST', `/mcp-requests/${first.data.proposalId}/decision`, { approve: false, comment: '' });
  });
});

describe('sources of data points', () => {
  it('are part of the import format: imported, exported and imported again unchanged – also on a derived profile', async () => {
    const files = [
      {
        name: 'c80-v5.yaml',
        content: [
          'version: 1',
          'device_profile:',
          '  id: example-c80-v5',
          '  name: Example Controls C80, firmware 5',
          '  extends: example-c80',
          '  interfaces:',
          '    - id: opc-ua',
          '      groups:',
          '        - name: Spindle',
          '          data_points:',
          '            - { id: spindle_speed, address: "ns=4;s=/C80/spindle_speed", source: { document: C80 Operating Manual v5, page: 98 } }',
          '            - { id: spindle_load, source: null }',
          '            - { id: spindle_temp, name: Spindle temperature, unit: Cel, source: { document: DOC-77, section: "7.1 Temperatures" } }',
        ].join('\n'),
      },
    ];
    const preview = await s.api('POST', '/plant/import/preview', { files, mode: 'update' });
    expect(preview.ok, JSON.stringify(preview.problems)).toBe(true);
    await s.api('POST', '/plant/import', { files, mode: 'update' });
    const v5 = await s.api('GET', '/plant/profiles/example-c80-v5');
    const points = new Map<string, any>(v5.interfaces[0].groups.flatMap((g: any) => g.dataPoints).map((d: any) => [d.id, d]));
    expect(points.get('spindle_speed').source).toEqual({ document: 'C80 Operating Manual v5', page: '98', section: '' });
    // null: the derived device's data point has no source, not the inherited one
    expect(points.get('spindle_load').source).toBeNull();
    expect(points.get('run_state').source).toEqual({ document: MANUAL, page: '101', section: '6.3 OPC UA variables' });
    expect(points.get('spindle_temp').source).toEqual({ document: 'DOC-77', page: '', section: '7.1 Temperatures' });
    expect(v5.origins.points.spindle_speed.fields).toEqual(expect.arrayContaining(['address', 'source']));
    const exported = await s.api('GET', '/plant/export?profile=example-c80-v5');
    const file = YAML.parse(exported);
    const own = file.device_profile.interfaces[0].groups[0].data_points;
    expect(own).toEqual(
      expect.arrayContaining([
        { id: 'spindle_speed', address: 'ns=4;s=/C80/spindle_speed', source: { document: 'C80 Operating Manual v5', page: '98' } },
        { id: 'spindle_load', source: null },
      ]),
    );
    // the export imports back without a change
    const again = await s.api('POST', '/plant/import/preview', { files: [{ name: 'again.yaml', content: exported }], mode: 'update' });
    expect(again.ok).toBe(true);
    expect(again.counts).toMatchObject({ add: 0, change: 0 });
  });

  it('are kept when a person edits a data point, and can be changed there', async () => {
    const p = await s.api('GET', '/plant/profiles/example-c80');
    const own = p.own;
    const { id: _id, ...body } = own;
    // a form sends the data point back with its source: it stays; a source without a document is refused
    expect(await status(s.api('PUT', '/plant/profiles/example-c80', body))).toEqual({ status: 200 });
    expect((await s.api('GET', '/plant/profiles/example-c80/points/door_open')).point.source).toMatchObject({ document: MANUAL, page: '103' });
    const bad = structuredClone(body);
    bad.interfaces[0].groups[0].dataPoints[0].source = { document: '', page: '1', section: '' };
    expect(await status(s.api('PUT', '/plant/profiles/example-c80', bad))).toMatchObject({ status: 400 });
  });
});
