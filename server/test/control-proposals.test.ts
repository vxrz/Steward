import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Control catalogues and mappings proposed by an AI assistant (#74): sent in parts through MCP, reviewed in the AI
 * requests inbox against the catalogue of the same key, accepted in full or in parts, audited, never applied directly.
 */
let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const tok: Record<string, string> = {};
const MODERN = '2026-07-28';
const seen: string[] = [];

interface Res {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

async function post(token: string | null, body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Res> {
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text);
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

let nextId = 1;
/** A modern (2026-07-28) request with the required _meta and headers. */
function modern(token: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}): Promise<Res> {
  const name = method === 'resources/read' ? params.uri : method === 'tools/call' ? params.name : undefined;
  return post(
    token,
    {
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(typeof name === 'string' ? { 'mcp-name': name } : {}), ...extra },
  );
}

/** tools/call → { isError, data } (data = structuredContent, or the error text). */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any; res: Res }> {
  const res = await modern(token, 'tools/call', { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  const r = res.body.result;
  expect(r, res.text).toBeTruthy();
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent, res };
}

async function toolNames(token: string): Promise<string[]> {
  const r = await modern(token, 'tools/list');
  return r.body.result.tools.map((t: any) => t.name);
}
const mcpToken = async (c: Client, name: string): Promise<string> => (await c('POST', '/me/tokens', { name, scope: 'mcp' })).token;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  // off by default: no proposal tools until an administrator allows them
  tok.dana0 = await mcpToken(dana, 'mcp dana before');
  expect(await toolNames(tok.dana0)).not.toContain('propose_control_catalogue');
  await s.api('PUT', '/mcp-server', { controlProposals: true });
  tok.dana = await mcpToken(dana, 'mcp dana');
  tok.olivia = await mcpToken(olivia, 'mcp olivia');
});
afterAll(async () => s?.app.close());

const controls = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ ref: `ACME-${from + i}`, title: `Requirement ${from + i}`, description: `Text of requirement ${from + i}` }));

describe('AI-proposed control catalogues', () => {
  it('only people who may map controls get the tools', async () => {
    expect(await toolNames(tok.dana)).toEqual(
      expect.arrayContaining(['propose_control_catalogue', 'propose_control_mappings', 'list_control_catalogues', 'find_mapping_targets']),
    );
    expect(await toolNames(tok.olivia)).not.toContain('propose_control_catalogue');
    const refused = await modern(tok.olivia, 'tools/call', {
      name: 'propose_control_catalogue',
      arguments: { key: 'ACME', name: 'x', controls: controls(1, 1), reason: 'test it' },
    });
    expect(JSON.stringify(refused.body)).toMatch(/Unknown tool|You may not/);
  });

  let id: string;
  it('arrives in parts and waits for the last one before anyone can accept it', async () => {
    const first = await call(tok.dana, 'propose_control_catalogue', {
      key: 'ACME-ISMS',
      name: 'ACME ISMS policy',
      version: '2026-03',
      controls: controls(1, 200),
      reason: 'Converted from the ACME ISMS policy (Word, March 2026)',
      more: true,
    });
    expect(first.isError, first.data).toBe(false);
    id = first.data.requestId;
    expect(first.data.complete).toBe(false);
    let r = await s.api('GET', `/mcp-requests/${id}`);
    expect(r).toMatchObject({ kind: 'catalogue', mode: 'review', canApprove: false, proposal: { incomplete: true, existing: null } });
    expect(r.proposal.controls).toHaveLength(200);
    // a duplicate ref in a later part is refused
    expect(
      (await call(tok.dana, 'propose_control_catalogue', { key: 'ACME-ISMS', name: 'ACME ISMS policy', controls: controls(5, 1), proposalId: id })).data,
    ).toMatch(/appears twice/);
    const last = await call(tok.dana, 'propose_control_catalogue', { key: 'ACME-ISMS', name: 'ACME ISMS policy', controls: controls(201, 10), proposalId: id });
    expect(last.data.complete).toBe(true);
    r = await s.api('GET', `/mcp-requests/${id}`);
    expect(r).toMatchObject({ canApprove: true, proposal: { incomplete: false } });
    expect(r.proposal.controls).toHaveLength(210);
    expect(r.proposal.controls.every((c: any) => c.change === 'new')).toBe(true);
    // 14 days to review
    expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBe(14 * 86_400_000);
    // the designer who asked may not accept a catalogue; an administrator may
    expect((await dana('GET', `/mcp-requests/${id}`)).canApprove).toBe(false);
    expect((await s.api('GET', '/mcp-requests?scope=decide')).some((x: any) => x.id === id)).toBe(true);
  });

  it('the reviewer accepts an edited selection; the catalogue is created and the step audited', async () => {
    const r = await s.api('GET', `/mcp-requests/${id}`);
    const skip = r.proposal.controls.slice(205).map((c: any) => c.ref);
    const done = await s.api('POST', `/mcp-requests/${id}/decision`, {
      approve: true,
      comment: 'Checked against the Word document',
      selection: { catalogue: { skip, edits: [{ ref: 'ACME-1', title: 'Edited by the reviewer', description: 'Text of requirement 1' }], remove: [] } },
    });
    expect(done).toMatchObject({ status: 'done', resultBody: { key: 'ACME-ISMS', created: true, added: 205, updated: 0, removed: 0 } });
    const list = await s.api('GET', '/compliance/controls?catalogue=ACME-ISMS');
    expect(list).toHaveLength(205);
    expect(list.find((c: any) => c.ref === 'ACME-1').title).toBe('Edited by the reviewer');
    const audit = await s.api('GET', '/audit?action=control_catalogue.imported&limit=1');
    expect(audit[0].summary).toContain("proposed by dana's AI assistant, accepted by admin");
  });

  it('a second proposal for the same key shows what changes, and removes only what the reviewer ticks', async () => {
    const changed = [
      { ref: 'ACME-1', title: 'Requirement 1 (rev. 2)', description: 'New text' },
      ...controls(2, 2),
      { ref: 'ACME-NEW', title: 'A new one', description: '' },
    ];
    const p = await call(tok.dana, 'propose_control_catalogue', {
      key: 'ACME-ISMS',
      name: 'ACME ISMS policy',
      version: '2026-09',
      controls: changed,
      reason: 'Revision 2 of the policy',
    });
    const r = await s.api('GET', `/mcp-requests/${p.data.requestId}`);
    expect(r.proposal.existing).toMatchObject({ version: '2026-03' });
    expect(r.proposal.controls.map((c: any) => c.change)).toEqual(['changed', 'same', 'same', 'new']);
    expect(r.proposal.controls[0].before.title).toBe('Edited by the reviewer');
    expect(r.proposal.missing).toHaveLength(202);
    const done = await s.api('POST', `/mcp-requests/${p.data.requestId}/decision`, {
      approve: true,
      comment: '',
      selection: { catalogue: { skip: [], edits: [], remove: ['ACME-4', 'ACME-5'] } },
    });
    expect(done.resultBody).toMatchObject({ added: 1, updated: 1, removed: 2 });
    expect(await s.api('GET', '/compliance/controls?catalogue=ACME-ISMS')).toHaveLength(204);
    expect((await s.api('GET', '/compliance/catalogues')).find((c: any) => c.key === 'ACME-ISMS').version).toBe('2026-09');
  });
});

describe('AI-proposed control mappings', () => {
  it('only existing controls and items the assistant may see; accepted in part, marked as proposed', async () => {
    const targets = await call(tok.dana, 'find_mapping_targets', { kind: 'process', query: '' });
    expect(targets.data.items.length).toBeGreaterThan(0);
    const pid = targets.data.items[0].id;
    expect(
      (
        await call(tok.dana, 'propose_control_mappings', {
          catalogueKey: 'ACME-ISMS',
          mappings: [{ ref: 'NOPE', kind: 'process', targetId: pid, reason: 'x y z' }],
          reason: 'Mappings',
        })
      ).data,
    ).toMatch(/Not in catalogue/);
    expect(
      (
        await call(tok.dana, 'propose_control_mappings', {
          catalogueKey: 'ACME-ISMS',
          mappings: [{ ref: 'ACME-2', kind: 'process', targetId: 'proc_nope', reason: 'x y z' }],
          reason: 'Mappings',
        })
      ).data,
    ).toMatch(/Not found/);
    const p = await call(tok.dana, 'propose_control_mappings', {
      catalogueKey: 'ACME-ISMS',
      mappings: [
        { ref: 'ACME-2', kind: 'process', targetId: pid, reason: 'The process documents the access review' },
        { ref: 'ACME-3', kind: 'process', targetId: pid, reason: 'Also covers the quarterly check' },
      ],
      reason: 'Mappings for the ACME ISMS policy',
    });
    expect(p.isError, p.data).toBe(false);
    // the designer may accept mappings (they may map controls), and accepts only the first
    const r = await dana('GET', `/mcp-requests/${p.data.requestId}`);
    expect(r).toMatchObject({ canApprove: true, proposal: { type: 'mappings', catalogueKey: 'ACME-ISMS' } });
    expect(r.proposal.mappings.map((m: any) => m.state)).toEqual(['new', 'new']);
    const done = await dana('POST', `/mcp-requests/${p.data.requestId}/decision`, { approve: true, comment: '', selection: { mappings: [0] } });
    expect(done.resultBody).toMatchObject({ mapped: 1, skipped: 0 });
    const c2 = (await s.api('GET', '/compliance/controls?catalogue=ACME-ISMS')).find((c: any) => c.ref === 'ACME-2');
    expect(c2.tags[0]).toMatchObject({ kind: 'process', targetId: pid, suggestion: { requestedBy: 'dana', acceptedBy: 'dana', tokenName: 'mcp dana' } });
    const c3 = (await s.api('GET', '/compliance/controls?catalogue=ACME-ISMS')).find((c: any) => c.ref === 'ACME-3');
    expect(c3.tags).toHaveLength(0);
  });

  it('a viewer sees nothing of it; a rejected proposal changes nothing', async () => {
    const p = await call(tok.dana, 'propose_control_mappings', {
      catalogueKey: 'ACME-ISMS',
      mappings: [
        { ref: 'ACME-6', kind: 'process', targetId: (await call(tok.dana, 'find_mapping_targets', { kind: 'process' })).data.items[0].id, reason: 'Covers it' },
      ],
      reason: 'One more mapping',
    });
    await expect(vera('GET', `/mcp-requests/${p.data.requestId}`)).rejects.toMatchObject({ status: 404 });
    const rej = await s.api('POST', `/mcp-requests/${p.data.requestId}/decision`, { approve: false, comment: 'Not evidence' });
    expect(rej.status).toBe('rejected');
    expect((await s.api('GET', '/compliance/controls?catalogue=ACME-ISMS')).find((c: any) => c.ref === 'ACME-6').tags).toHaveLength(0);
    const st = await call(tok.dana, 'get_operation_request', { requestId: p.data.requestId });
    expect(st.data).toMatchObject({ status: 'rejected', comment: 'Not evidence' });
  });
});
