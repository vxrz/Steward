import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso, parseJson } from '../util.js';
import type { AuthUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { findUserByName, listUsers, toAuthUser } from '../auth/users.js';
import { t as translate, type MessageKey, type Vars } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { productAccess } from './access.js';
import type { ProductRow } from './store.js';

/**
 * The notifications of consumers, access and governance (0.24.0, ADR 0036 part 17 phase 2), each sent once
 * (dp_notices: kind, item, key – claimed before sending) and only to who may see the product:
 *
 *  - `dataproduct.access_requested` – someone asks for access to an output port: to who decides (the product owners,
 *    else who manages the product), never the requester; once per request (and once more when a first approval of
 *    four eyes waits for the second person).
 *  - `dataproduct.access_decided` – a request was approved or refused: to the requester, once per request.
 *  - `dataproduct.endorsement_review` – an endorsement is due for its review (30 days ahead, passed, or flagged by a
 *    breaking change or a rating below the floor): to the endorsers and the product owners, once per product, review
 *    date and reason.
 *  - `dataproduct.access_review_due` – a port's periodic access review is due: to the product owners, once per port,
 *    environment and due date.
 */

/** Claims a notice (true: not sent before, send it now). */
export function claimNotice(kind: string, itemId: string, key: string): boolean {
  return (
    db().run('INSERT INTO dp_notices (kind, item_id, notice_key, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', kind, itemId, key, nowIso()).changes ===
    1
  );
}

export interface Person {
  info: UserInfo;
  auth: AuthUser;
}

/** Active users once per call, with their AuthUser. */
export function people(): Person[] {
  return listUsers()
    .filter((u) => u.active)
    .map((info) => ({ info, auth: toAuthUser(info) }));
}

/** The people `subjects` (`user:`, `team:`) name. */
export const namedPeople = (all: Person[], subjects: readonly string[]): Person[] =>
  subjects.length ? all.filter((p) => subjects.some((s) => matches(p.auth, s))) : [];

export const seesProduct = (p: Person, product: ProductRow): boolean => productAccess(p.auth, product).permissions.length > 0;

/**
 * Who decides access requests of a product: its named product owners; without any, who may manage it (its owning
 * teams' designers, the module's managers) – administrators only when nobody else does.
 */
export function decidersOf(all: Person[], product: ProductRow): Person[] {
  const owners = namedPeople(all, parseJson<string[]>(product.owners, []));
  if (owners.length) return owners.filter((p) => seesProduct(p, product));
  const managers = all.filter((p) => !isAdmin(p.auth) && productAccess(p.auth, product).permissions.includes('manage'));
  return managers.length ? managers : all.filter((p) => isAdmin(p.auth));
}

/** Sends a notice in the recipients' languages; never throws (a notice that cannot be sent is logged). */
export function send(o: {
  event: 'dataproduct.access_requested' | 'dataproduct.access_decided' | 'dataproduct.endorsement_review' | 'dataproduct.access_review_due';
  recipients: Person[];
  link: string;
  key: string;
  title: (l: Locale) => string;
  lines: (l: Locale) => string[];
  data: Record<string, unknown>;
}): number {
  const recipients = [...new Map(o.recipients.map((p) => [p.info.id, p])).values()];
  if (!recipients.length) return 0;
  try {
    notify({
      event: o.event,
      text: (l) => ({ title: o.title(l), body: o.lines(l).join('\n') }),
      link: o.link,
      recipients: recipients.map((p) => p.info),
      inAppKey: o.key,
      externalKey: o.key,
      data: o.data,
    });
    return recipients.length;
  } catch (err) {
    logger.warn({ err, event: o.event }, 'data product notice could not be sent');
    return 0;
  }
}

export const productLink = (productId: string, tab = '') => `/data-products/${encodeURIComponent(productId)}${tab ? `/${tab}` : ''}`;

/** The person behind a user name (null: unknown or deactivated). */
export function personOf(username: string): Person | null {
  const info = findUserByName(username);
  return info && info.active ? { info, auth: toAuthUser(info) } : null;
}

/** The module's server texts (keys under dataProductGovernance.* in server/src/i18n/locales). */
export const t = (l: Locale, key: string, vars?: Vars): string => translate(l, key as MessageKey, vars);

export { titleName };
