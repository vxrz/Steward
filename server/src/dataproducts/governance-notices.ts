import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import type { AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { findUserByName, listUsers, toAuthUser } from '../auth/users.js';
import { t as translate, type MessageKey, type Vars } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { absoluteLink } from '../notifications/settings.js';
import { productAccess } from './access.js';
import type { ProductRow } from './store.js';

/**
 * The notifications of consumers, access and governance (0.24.0, ADR 0036 part 17 phase 2; 0.25.1, ADR 0038 part 6),
 * each sent once (dp_notices: kind, item, key – claimed before sending) and only to who may see the product. They go to
 * the product's **IT maintainers** – who may edit it through owning teams, roles and shares (administrators only when
 * nobody else may) – never to contacts: Steward never e-mails a contact. Each carries a link to the affected
 * consumers' contacts, which the product's Ports tab lists with copy and CSV, so the maintainers can inform them:
 *
 *  - `dataproduct.endorsement_review` – an endorsement is due for its review (30 days ahead, passed, or flagged by a
 *    breaking change or a rating below the floor): once per product, review date and reason.
 *  - `dataproduct.access_review_due` – a port's periodic access review is due: once per port, environment and due date.
 *
 * `dataproduct.deprecated` and `dataproduct.contract_breaking` (notices.ts, contract-hooks.ts) use maintainersOf too.
 * `dataproduct.access_requested` and `dataproduct.access_decided` were retired in 0.25.1 with the access requests.
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

export const seesProduct = (p: Person, product: ProductRow): boolean => productAccess(p.auth, product).permissions.length > 0;

/**
 * The product's IT maintainers: who may edit it (its owning teams' members with an editing role, the module's managers
 * on a product without owning teams, Edit and Manage shares) – administrators only when nobody else may. Owner fields
 * and contacts never make anyone a recipient (ADR 0038 part 6).
 */
export function maintainersOf(all: Person[], product: ProductRow): Person[] {
  const editors = all.filter((p) => !isAdmin(p.auth) && productAccess(p.auth, product).permissions.includes('edit'));
  return editors.length ? editors : all.filter((p) => isAdmin(p.auth));
}

/** The in-app page that lists the consumers' contacts of a product (or of one of its ports), with copy and CSV. */
export const consumerContactsLink = (productId: string, portId?: string): string =>
  `/data-products/${encodeURIComponent(productId)}/ports?contacts=${portId ? encodeURIComponent(portId) : 'all'}`;

/** Sends a notice in the recipients' languages; never throws (a notice that cannot be sent is logged). */
export function send(o: {
  event: 'dataproduct.endorsement_review' | 'dataproduct.access_review_due';
  recipients: Person[];
  link: string;
  /** The consumers' contacts page (consumerContactsLink): a button in e-mail and Teams, a line in the app */
  contacts?: string;
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
      text: (l) => ({
        title: o.title(l),
        body: o.lines(l).join('\n'),
        ...(o.contacts ? { parts: { actions: [{ label: t(l, 'dataProductGovernance.contactsAction'), href: absoluteLink(o.contacts) }] } } : {}),
      }),
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
