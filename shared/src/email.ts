import { z } from 'zod';

/** The longest e-mail address SMTP allows (RFC 5321) */
export const EMAIL_MAX = 254;

/**
 * One rule for e-mail addresses everywhere (#18): user profiles, credential owners, service contacts, report
 * recipients, record signers and auditors who receive checkpoints. "local@domain.tld" without spaces and without
 * the characters that would make it a list or a display name for the mail transport (<>()[]\,;:"). Letters
 * beyond ASCII are allowed, as in internationalised addresses.
 */
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]+$/;

export function isEmailAddress(s: string): boolean {
  return s.length <= EMAIL_MAX && EMAIL_RE.test(s);
}

/** The same rule as a zod schema (trimmed; lower-cased with { lowerCase: true }). */
export function emailAddressSchema(o: { lowerCase?: boolean; max?: number } = {}) {
  const base = o.lowerCase ? z.string().trim().toLowerCase() : z.string().trim();
  return base.max(o.max ?? EMAIL_MAX).refine(isEmailAddress, { message: 'Enter a valid e-mail address' });
}
