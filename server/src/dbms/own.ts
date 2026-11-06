import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import type { LookupFunction } from 'node:net';
import { config } from '../config.js';
import type { DatabaseTarget } from '../database/sql.js';
import { guardedLookup } from '../platforms/outbound.js';
import { DbError } from './types.js';

/**
 * Steward's own database is never a database platform (ADR 0008): a platform that reaches it would make the
 * statements of process designers a path into the instance's own tables, even through a read-only account. Other
 * databases on the same server stay allowed – PostgreSQL has no cross-database queries and `dblink` is refused – so a
 * small setup can keep its application databases in Steward's cluster. Host and port are compared by address,
 * resolved like the guarded lookup (every loopback, unspecified or local interface address counts as this machine),
 * and the database by name. The check runs before connecting (a clear error) and again on the address the socket
 * connects to (no DNS rebinding in between).
 */

export interface Endpoint {
  hosts: string[];
  port: number;
  /** Steward's own database on that server */
  database: string;
}

/** Steward's own database server (null for SQLite). A socket directory (or no host) means this machine. */
export function ownDatabaseEndpoint(target: DatabaseTarget = config.database): Endpoint | null {
  if (target.kind !== 'postgres') return null;
  let u: URL;
  try {
    // postgres://user@/db?host=/run/postgresql: no host in the URL (a socket directory or the default) is this machine
    u = new URL(target.url.replace(/^(postgres(?:ql)?:\/\/(?:[^@/?]*@)?)(?=[/?]|$)/i, '$1localhost'));
  } catch {
    return null; // not parseable here: the database layer could not have connected either
  }
  const param = u.searchParams.get('host');
  const raw = (param ?? decodeURIComponent(u.hostname)).split(',').map((h) => h.trim().replace(/^\[|\]$/g, ''));
  const hosts = raw.map((h) => (!h || h.startsWith('/') ? 'localhost' : h));
  const port = Number(u.searchParams.get('port') || u.port || 5432);
  // the database of the URL, else PostgreSQL's default: the user name (else "postgres")
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || u.searchParams.get('dbname') || decodeURIComponent(u.username) || 'postgres';
  return { hosts, port, database };
}

const unmap = (ip: string) =>
  ip
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')
    .replace(/%.*$/, '')
    .toLowerCase();

/** Loopback, unspecified or an address of this machine's interfaces. */
export function isLocalAddress(ipRaw: string): boolean {
  const ip = unmap(ipRaw);
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0' || ip.startsWith('127.')) return true;
  return Object.values(os.networkInterfaces())
    .flat()
    .some((a) => a && unmap(a.address) === ip);
}

export type AddressLookup = (host: string) => Promise<string[]>;

/** The addresses of a host (an address stays itself; a name that does not resolve has none). */
export const resolveAddresses: AddressLookup = async (host) => {
  if (net.isIP(host)) return [unmap(host)];
  try {
    return (await dns.lookup(host, { all: true, verbatim: true })).map((a) => unmap(a.address));
  } catch {
    return []; // unresolvable: the connection fails on its own
  }
};

/** Whether one of `addresses` (on `port`) is the server of Steward's own database. */
export async function isOwnDatabase(addresses: string[], port: number, own: Endpoint | null, lookup: AddressLookup = resolveAddresses): Promise<boolean> {
  if (!own || port !== own.port || !addresses.length) return false;
  const ownAddrs = (await Promise.all(own.hosts.map(lookup))).flat();
  const mine = addresses.map(unmap);
  if (mine.some((a) => ownAddrs.includes(a))) return true;
  return mine.some(isLocalAddress) && ownAddrs.some(isLocalAddress);
}

export const ownDatabaseError = (host: string, port: number, database: string) =>
  new DbError(
    'DB_OWN_DATABASE',
    `${database} on ${host}:${port} is the database of Steward itself – a database platform may not read it (other databases on that server are fine)`,
    { host: `${host}:${port}`, database },
    403,
  );

/** The database a platform names is Steward's own (names compared as the server does: exactly). */
const sameDatabase = (database: string, own: Endpoint) => database === own.database;

/** Refuses host:port/database when it is Steward's own database (before connecting). */
export async function assertNotOwnDatabase(
  host: string,
  port: number,
  database: string,
  own = ownDatabaseEndpoint(),
  lookup: AddressLookup = resolveAddresses,
): Promise<void> {
  if (!own || !sameDatabase(database, own)) return;
  if (own.hosts.some((h) => h.toLowerCase() === host.toLowerCase()) && port === own.port) throw ownDatabaseError(host, port, database);
  if (await isOwnDatabase(await lookup(host), port, own, lookup)) throw ownDatabaseError(host, port, database);
}

/**
 * The guarded lookup for a database socket to `port` and `database`: the same address checks, and the address
 * connected to is not the server of Steward's own database when the platform names that database.
 */
export function databaseLookup(port: number, database: string, own = ownDatabaseEndpoint()): LookupFunction {
  return (hostname, options, callback) => {
    guardedLookup(hostname, options, ((err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => {
      if (err || !own || !sameDatabase(database, own)) return (callback as (...a: unknown[]) => void)(err, address, family);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      isOwnDatabase(list, port, own).then(
        (hit) =>
          hit
            ? (callback as (...a: unknown[]) => void)(ownDatabaseError(hostname, port, database), '', 4)
            : (callback as (...a: unknown[]) => void)(null, address, family),
        (e) => (callback as (...a: unknown[]) => void)(e, '', 4),
      );
    }) as never);
  };
}
