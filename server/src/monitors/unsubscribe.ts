import crypto from 'node:crypto';
import { audit } from '../audit.js';
import { db } from '../db.js';
import { absoluteLink } from '../notifications/settings.js';
import { readSetting, writeSetting } from '../settings.js';
import { nowIso, parseJson } from '../util.js';

/**
 * Unsubscribing for the people a monitor's notification output writes to by plain e-mail address (0.29.0). Every such
 * message carries a link `/unsubscribe/<token>` (and the List-Unsubscribe headers of RFC 8058). The token names the
 * monitor and the output and carries a keyed signature (HMAC-SHA-256) over those and the address: it contains no address
 * and no other detail, cannot be made without the instance's key, and does not expire (an old mail must still work). The
 * address is found by trying the output's addresses against the signature.
 */

/** Per-installation key for the links (kept in the database like the pseudonym key: it protects a link, not a secret). */
function linkKey(): Buffer {
  let k = readSetting<string | null>('security.unsubscribeKey', null);
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    writeSetting('security.unsubscribeKey', k);
  }
  return Buffer.from(k, 'base64');
}

const sign = (monitorId: string, outputId: string, address: string): string =>
  crypto.createHmac('sha256', linkKey()).update(`monitor-unsubscribe-v1\n${monitorId}\n${outputId}\n${address.trim().toLowerCase()}`).digest('base64url');

export function unsubscribeToken(monitorId: string, outputId: string, address: string): string {
  return `${Buffer.from(JSON.stringify([monitorId, outputId])).toString('base64url')}.${sign(monitorId, outputId, address)}`;
}

/** The link in a message to `address` (absolute, under the public address). */
export const unsubscribeUrl = (monitorId: string, outputId: string, address: string): string =>
  absoluteLink(`/unsubscribe/${unsubscribeToken(monitorId, outputId, address)}`);

interface Found {
  monitorId: string;
  monitorName: string;
  outputId: string;
  address: string;
}

/** The monitor, output and address a token is valid for; null when the token is not valid (or the address is gone already). */
function find(token: string): Found | null {
  const [head, mac] = token.split('.');
  if (!head || !mac || mac.length !== 43 || token.length > 400) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length !== 2 || typeof ids[0] !== 'string' || typeof ids[1] !== 'string') return null;
  const [monitorId, outputId] = ids as [string, string];
  const row = db().get<{ id: string; name: string; definition: string; is_template: number }>(
    'SELECT id, name, definition, is_template FROM monitors WHERE id = ?',
    monitorId,
  );
  if (!row || row.is_template) return null;
  const def = parseJson<{ outputs?: { id?: string; type?: string; emails?: string[] }[] }>(row.definition, {});
  const out = def.outputs?.find((o) => o.id === outputId && o.type === 'notification');
  const want = Buffer.from(mac);
  for (const address of out?.emails ?? []) {
    const have = Buffer.from(sign(monitorId, outputId, address));
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) return { monitorId, monitorName: row.name, outputId, address };
  }
  // a valid signature for an address that is no longer listed: already unsubscribed – nothing to do, and nothing to tell
  return null;
}

/** Whether the token names a recipient that is still listed (for the confirmation page; reveals nothing else). */
export const unsubscribeValid = (token: string): boolean => find(token) !== null;

/**
 * Removes the address from the output, without sign-in. The monitor's id when the token was valid (the caller reloads it); a token used before answers null like a wrong one. The change counts like a change of the monitor
 * (version, audit); the audit entry names the monitor and the output, never the address.
 */
export function unsubscribeRecipient(token: string): string | null {
  const found = find(token);
  if (!found) return null;
  const done = db().tx(() => {
    const row = db().get<{ definition: string }>('SELECT definition FROM monitors WHERE id = ?', found.monitorId);
    if (!row) return false;
    const def = parseJson<{ outputs?: { id?: string; type?: string; emails?: string[] }[] }>(row.definition, {});
    const out = def.outputs?.find((o) => o.id === found.outputId && o.type === 'notification');
    if (!out?.emails?.includes(found.address)) return false;
    out.emails = out.emails.filter((e) => e !== found.address);
    if (!out.emails.length) delete out.emails;
    db().run(
      'UPDATE monitors SET definition = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      JSON.stringify(def),
      nowIso(),
      'system',
      found.monitorId,
    );
    audit({
      actor: 'system',
      action: 'monitor.recipient_unsubscribed',
      entityType: 'monitor',
      entityId: found.monitorId,
      summary: `A recipient outside Steward unsubscribed from output "${found.outputId}" of monitor "${found.monitorName}"`,
      details: { output: found.outputId },
    });
    return true;
  });
  return done ? found.monitorId : null;
}
