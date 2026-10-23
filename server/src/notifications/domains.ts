import { listUsers } from '../auth/users.js';
import { HttpError } from '../util.js';
import { getNotificationSettings } from './settings.js';

/**
 * Plain e-mail addresses outside Steward (credential owners, report recipients) only receive mail when
 * their domain is allowed: Settings → Notifications → "Allowed e-mail domains for addresses outside
 * Steward". An empty list means the company's own domains, taken from the active users' addresses – a
 * domain counts when an administrator or a single sign-on account (address from the identity provider)
 * uses it, or at least two active users do, so one user cannot open a domain by editing their own profile.
 */

export const ALLOWED_DOMAINS_SETTING = 'Settings → Notifications → "Allowed e-mail domains for addresses outside Steward"';

export const emailDomain = (addr: string): string => {
  const a = addr.trim().toLowerCase();
  return a.slice(a.lastIndexOf('@') + 1).replace(/\.$/, '');
};

/** The configured rules, or the domains of the users' own addresses when none are configured. */
export function allowedDomainRules(): string[] {
  const configured = getNotificationSettings().allowedEmailDomains;
  if (configured.length) return configured;
  const count = new Map<string, number>();
  const trusted = new Set<string>();
  for (const u of listUsers()) {
    if (!u.active || !u.email?.includes('@')) continue;
    const d = emailDomain(u.email);
    if (!d) continue;
    count.set(d, (count.get(d) ?? 0) + 1);
    if (u.authSource !== 'local' || u.roles.includes('admin')) trusted.add(d);
  }
  return [...count].filter(([d, n]) => n >= 2 || trusted.has(d)).map(([d]) => d);
}

export function domainAllowed(addr: string, rules: string[] = allowedDomainRules()): boolean {
  const d = emailDomain(addr);
  if (!d || !addr.includes('@')) return false;
  return rules.some((r) => (r.startsWith('*.') ? d.endsWith(r.slice(1)) : d === r));
}

/** On save: refuses addresses whose domain is not allowed (with a message that names the setting). */
export function assertEmailsAllowed(addrs: string[]): void {
  if (!addrs.length) return;
  const rules = allowedDomainRules();
  const refused = addrs.filter((a) => !domainAllowed(a, rules));
  if (!refused.length) return;
  throw new HttpError(
    400,
    `E-mail ${refused.length === 1 ? 'address' : 'addresses'} ${refused
      .slice(0, 3)
      .map((a) => `"${a.slice(0, 254)}"`)
      .join(
        ', ',
      )}${refused.length > 3 ? ' …' : ''}: the domain is not allowed for addresses outside Steward. An administrator can allow it in ${ALLOWED_DOMAINS_SETTING}.`,
    'EMAIL_DOMAIN_NOT_ALLOWED',
    { addresses: refused.slice(0, 3).map((a) => a.slice(0, 254)), count: refused.length },
  );
}
