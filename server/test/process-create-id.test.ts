import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** "New process" (U7 of the 0.10 review): the dialog sends the id the person chose; it is taken as given or refused. */
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => s?.app.close());

const blank = (name: string) => ({
  name,
  description: '',
  connections: [],
  inputs: [],
  nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }],
  wires: [],
});

describe('creating a process with a chosen id', () => {
  it('takes the id as given and refuses one that exists', async () => {
    const p = await s.api('POST', '/processes', { definition: blank('Quarterly restore test'), id: 'restore-test-q' });
    expect(p.id).toBe('restore-test-q');
    expect(p.name).toBe('Quarterly restore test');
    await expect(s.api('POST', '/processes', { definition: blank('Another one'), id: 'restore-test-q' })).rejects.toThrow(/409/);
    // archived processes keep their id: it is not given out again
    await s.api('DELETE', '/processes/restore-test-q');
    await expect(s.api('POST', '/processes', { definition: blank('Again'), id: 'restore-test-q' })).rejects.toThrow(/409/);
    // not an id
    await expect(s.api('POST', '/processes', { definition: blank('Bad'), id: 'Not An Id' })).rejects.toThrow(/400/);
    await expect(s.api('POST', '/processes', { definition: blank('Bad'), id: '-x' })).rejects.toThrow(/400/);
    // without an id the name gives one, with a number when it is taken (as before)
    const a = await s.api('POST', '/processes', { definition: blank('Restore test q') });
    expect(a.id).toBe('restore-test-q-2');
  });
});
