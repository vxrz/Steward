import { describe, expect, it } from 'vitest';
import { cidrRange, ipValue, macOf, zoneLevels } from '@sm/shared';
import { timeLimit } from './time.js';

// Address formats of the OT network (#220): IEEE 802 MAC (EUI-48), IPv4/IPv6 and CIDR – parsed without regular
// expressions that could backtrack on long input.
describe('OT network formats', () => {
  it('reads IPv4, IPv6 and IPv6 with an IPv4 tail', () => {
    expect(ipValue('192.0.2.10')).toEqual({ v: 4, n: 0xc000020an });
    expect(ipValue('2001:db8::1')).toEqual({ v: 6, n: 0x20010db8000000000000000000000001n });
    expect(ipValue('::ffff:192.0.2.1')).toEqual({ v: 6, n: 0xffffc0000201n });
    expect(ipValue('::ffff:999.0.2.1')).toBeNull();
    expect(ipValue('not an address')).toBeNull();
  });

  it('stays fast on long input', () => {
    const t = Date.now();
    for (const s of [`::${'0'.repeat(50_000)}.1`, `${'1.'.repeat(30_000)}1`, `${'0'.repeat(100_000)}`]) {
      expect(ipValue(s)).toBeNull();
      expect(cidrRange(`${s}/24`)).toBeNull();
      expect(macOf(s)).toBeNull();
    }
    expect(Date.now() - t).toBeLessThan(timeLimit(500));
  });

  it('normalises MAC addresses and CIDR ranges', () => {
    expect(macOf('ac:de:48:00:00:80')).toBe('AC-DE-48-00-00-80');
    expect(macOf('acde.4800.0080')).toBe('AC-DE-48-00-00-80');
    expect(cidrRange('198.51.100.0/24')).toMatchObject({ v: 4, first: 0xc6336400n, last: 0xc63364ffn });
  });
});

// The levels of the OT network diagram (#230): the zone's own level, else one derived for drawing only.
describe('zone levels (Purdue model)', () => {
  const zone = (id: string, name: string, extra: Partial<{ level: 'dmz' | 'supervisory'; vlans: string[]; description: string }> = {}) => ({
    id,
    name,
    description: '',
    level: null,
    vlans: [],
    ...extra,
  });
  it('keeps a level that is set and reads the others from names, VLAN types, assets and conduits', () => {
    const levels = zoneLevels(
      [
        zone('a', 'Zone A'),
        zone('b', 'Zone B', { vlans: ['v-dmz'] }),
        zone('c', 'Zone C'),
        zone('d', 'Zone D'),
        zone('e', 'SCADA'),
        zone('f', 'Office network'),
        zone('g', 'Anything', { level: 'supervisory' }),
        zone('h', 'Cloud services'),
        zone('i', 'Plant IT'),
      ],
      {
        vlanType: new Map([['v-dmz', 'dmz']]),
        withAssets: new Set(['a']),
        // a – c – b (DMZ) – d: c sits between the cells and the DMZ, d beyond it
        conduits: [{ zones: ['a', 'c'] }, { zones: ['c', 'b'] }, { zones: ['b', 'd'] }],
      },
    );
    expect(Object.fromEntries([...levels].map(([id, l]) => [id, `${l.level}/${l.source}`]))).toEqual({
      a: 'control/assets',
      b: 'dmz/name',
      c: 'operations/default',
      d: 'enterprise/conduits',
      e: 'supervisory/name',
      f: 'enterprise/name',
      g: 'supervisory/set',
      h: 'external/name',
      i: 'enterprise/name',
    });
  });
  it('reads names in German and does not take the word "it" for IT', () => {
    const levels = zoneLevels([zone('a', 'Leitstand'), zone('b', 'Fertigungszellen'), zone('c', 'Where it all happens')], {
      vlanType: new Map(),
      withAssets: new Set(),
      conduits: [],
    });
    expect([...levels.values()].map((l) => l.level)).toEqual(['supervisory', 'control', 'operations']);
  });
});
