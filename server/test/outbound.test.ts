import { describe, expect, it } from 'vitest';
import {
  allowListMatches,
  assertNoSecretLeak,
  blockedAddressReason,
  egressSecretValues,
  secretEncodings,
  type SecretBinding,
} from '../src/platforms/outbound.js';

describe('F4 – always-denied addresses', () => {
  it('blocks cloud-metadata and link-local ranges', () => {
    expect(blockedAddressReason('169.254.169.254')).toMatch(/metadata|link-local/i);
    expect(blockedAddressReason('169.254.0.1')).toMatch(/link-local/i);
    expect(blockedAddressReason('100.100.100.200')).toMatch(/metadata/i);
    expect(blockedAddressReason('fd00:ec2::254')).toMatch(/metadata/i);
    expect(blockedAddressReason('fe80::1')).toMatch(/link-local/i);
    expect(blockedAddressReason('::ffff:169.254.169.254')).toMatch(/link-local|metadata/i);
  });
  it('allows ordinary private and public addresses (on-prem is the core use case)', () => {
    expect(blockedAddressReason('10.1.2.3')).toBeNull();
    expect(blockedAddressReason('192.168.0.5')).toBeNull();
    expect(blockedAddressReason('127.0.0.1')).toBeNull();
    expect(blockedAddressReason('93.184.216.34')).toBeNull();
  });
});

describe('F4 – allow-list matching', () => {
  const url = (s: string) => new URL(s);
  it('matches full origins, host globs, bare hosts and CIDRs', () => {
    expect(allowListMatches('https://api.example.com', url('https://api.example.com/x'))).toBe(true);
    expect(allowListMatches('https://api.example.com', url('https://other.example.com/x'))).toBe(false);
    expect(allowListMatches('*.example.com', url('https://a.example.com/x'))).toBe(true);
    expect(allowListMatches('*.example.com', url('https://example.com/x'))).toBe(true);
    expect(allowListMatches('intranet', url('http://intranet/x'))).toBe(true);
    expect(allowListMatches('10.0.0.0/8', url('http://10.3.4.5/x'))).toBe(true);
    expect(allowListMatches('10.0.0.0/8', url('http://11.3.4.5/x'))).toBe(false);
  });
});

describe('F2 – secret encodings and egress scan', () => {
  it('derives base64 / url-encoded forms', () => {
    const enc = secretEncodings('demo-secret');
    expect(enc).toContain('demo-secret');
    expect(enc).toContain(Buffer.from('demo-secret').toString('base64')); // ZGVtby1zZWNyZXQ=
  });

  const binding = (name: string, values: string[], allowedOrigin: string): SecretBinding => ({
    platformName: name,
    values,
    allowed: (u: string) => {
      try {
        return new URL(u).origin === allowedOrigin;
      } catch {
        return false;
      }
    },
  });

  it('blocks a secret (and its base64 form) sent to a non-allowed origin', async () => {
    const b = [binding('Hub', ['demo-secret'], 'https://hub.example.com')];
    await expect(assertNoSecretLeak('https://evil.example.com/x', { 'x-leak': 'demo-secret' }, undefined, b)).rejects.toThrow(/secret/i);
    const b64 = Buffer.from('demo-secret').toString('base64');
    await expect(assertNoSecretLeak('https://evil.example.com/x', {}, `token=${b64}`, b)).rejects.toThrow(/secret/i);
  });

  it('allows the same secret to the platform itself', async () => {
    const b = [binding('Hub', ['demo-secret'], 'https://hub.example.com')];
    await expect(assertNoSecretLeak('https://hub.example.com/login', { authorization: 'Bearer demo-secret' }, undefined, b)).resolves.toBeUndefined();
  });

  it('egressSecretValues ignores trivially short values', () => {
    expect(egressSecretValues({ apiKey: 'SUPER-SECRET', pin: '12' })).toEqual(['SUPER-SECRET']);
  });
});
