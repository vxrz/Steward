/**
 * Entries of the outbound allow-list (Settings → Outbound access): an origin (`https://host[:port]`), a host or host
 * glob (`*.example.com`, optional `:port`) or an IPv4 CIDR (`10.10.13.0/24`). One check for the form and the server,
 * matching what `allowListMatches` (server/src/platforms/outbound.ts) understands.
 */

export type AllowListProblem = 'path' | 'scheme' | 'cidr' | 'port' | 'host';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6 = /^\[?[0-9a-f:.]+\]?$/i;
const portOk = (p: string) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;

/** Why an entry is not usable, or null when it is fine. Empty entries are ignored by the caller. */
export function allowListEntryProblem(raw: string): AllowListProblem | null {
  const e = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    if (!/^https?:\/\//i.test(e)) return 'scheme';
    let u: URL;
    try {
      u = new URL(e);
    } catch {
      return 'host';
    }
    if (u.pathname !== '/' || u.search || u.hash || /^https?:\/\/[^/]+\/./i.test(e)) return 'path';
    return null;
  }
  if (e.includes('/')) {
    const [ip, bits] = e.split('/');
    if (!IPV4.test(ip ?? '') || !/^\d{1,2}$/.test(bits ?? '') || Number(bits) > 32) return 'cidr';
    return null;
  }
  if (IPV6.test(e) && e.includes(':') && e.split(':').length > 2) return null;
  const [host, port, ...rest] = e.split(':');
  if (rest.length) return 'host';
  if (port !== undefined && !portOk(port)) return 'port';
  if (IPV4.test(host ?? '')) return null;
  return HOST.test(host ?? '') ? null : 'host';
}

/** The entries of a multi-line text: one per line, trimmed, empty lines dropped. */
export function allowListLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}
