import { describe, expect, it } from 'vitest';
import { cidrRange, ipValue, macOf } from '@sm/shared';
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
