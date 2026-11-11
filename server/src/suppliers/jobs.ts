import { SUPPLIER_REMINDER_DAYS, SUPPLIERS_EXPIRING_DATASET, type DatasetRow, type Locale, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { runAs } from '../auth/context.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { publishDataset } from '../dashboards/datasets.js';
import { usersOfSubjects } from '../tickets/reminders.js';
import { expiringItems, type ExpiringItem } from './service.js';
import { contractVisible, supplierVisible } from './links.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { finishContractScopeUpgrade } from './contract-scope.js';

/**
 * Supplier reminders and the dataset "Suppliers: expiring" (0.17.0, ADR 0029):
 *  - `supplier.certificate_expiring`: to the supplier's owners and the owners of its active contracts 90 and 30 days
 *    before a certificate runs out;
 *  - `supplier.notice_due`: to the contract's owners 90 and 30 days before its notice-by date (the last day to give
 *    notice) – see recipientsOf() for the fallbacks.
 * Each reminder is claimed in supplier_reminders under a key of the date and the days ahead, so it goes out once –
 * also across restarts; a new date (a renewed certificate, a contract that rolled on) arms it again. Reminders that
 * passed already count as sent (no burst after a late entry). Only active suppliers remind; without owners, the
 * administrators get them (like the credentials register).
 */

const HOUR = 3_600_000;
let lastRun = 0;

function claim(itemId: string, key: string): boolean {
  return (
    db().run('INSERT INTO supplier_reminders (item_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', itemId, key, nowIso()).changes === 1
  );
}

/** The reminder due for an item now (the smallest threshold it is within), or null. */
export function plannedSupplierReminder(x: Pick<ExpiringItem, 'date' | 'days'>): { key: string; threshold: number } | null {
  if (x.days < 0) return null;
  const within = [...SUPPLIER_REMINDER_DAYS].sort((a, b) => a - b).find((d) => x.days <= d);
  return within === undefined ? null : { key: `${x.date}:${within}`, threshold: within };
}

function text(l: Locale, x: ExpiringItem): { title: string; body: string } {
  const vars = { supplier: titleName(x.supplierName), title: x.title, date: x.date, count: x.days };
  if (x.kind === 'certificate')
    return {
      title: t(l, 'supplierDue.certificateTitle', vars),
      body: [t(l, 'supplierDue.certificateBody', { ...vars, supplier: x.supplierName }), t(l, 'supplierDue.hint')].join('\n'),
    };
  return {
    title: t(l, 'supplierDue.noticeTitle', vars),
    body: [t(l, 'supplierDue.noticeBody', { ...vars, supplier: x.supplierName }), t(l, 'supplierDue.hint')].join('\n'),
  };
}

/**
 * Who a reminder goes to (ADR 0031 part 7), each person once and only who may see what it is about:
 *  - a notice-by date: the contract's owners; without owners the supplier's owners; without those – or when none of
 *    them may see the contract (a deleted team, a merge into another team's supplier) – the administrators;
 *  - a certificate: the supplier's owners and the owners of every active contract of the supplier; without any the
 *    administrators.
 */
export function recipientsOf(x: ExpiringItem, all: UserInfo[]): UserInfo[] {
  const admins = () => all.filter((u) => u.roles.includes('admin'));
  if (x.kind === 'notice') {
    const owners = noticeOwners(x, all);
    return owners.length ? owners : admins();
  }
  const supplier = db().get<{ id: string; owners: string }>('SELECT id, owners FROM suppliers WHERE id = ?', x.supplierId);
  const users = usersOfSubjects([...new Set([...x.owners, ...x.activeContractOwners])], all);
  const sees = (u: UserInfo) => !supplier || runAs(toAuthUser(u), () => supplierVisible(supplier));
  const seen = users.filter(sees);
  return seen.length ? seen : admins();
}

/**
 * The owners a notice-by reminder goes to before the fallback: the contract's owners, else the supplier's – only who
 * may see the contract. Empty: the administrators get it (recipientsOf, and their daily summary).
 */
export function noticeOwners(x: ExpiringItem, all: UserInfo[]): UserInfo[] {
  const subjects = x.contractOwners.length ? x.contractOwners : x.owners;
  if (!subjects.length) return [];
  const c = db().get<{ id: string; supplier_id: string; owners: string }>('SELECT id, supplier_id, owners FROM supplier_contracts WHERE id = ?', x.itemId);
  if (!c) return [];
  const supplier = db().get<{ id: string; owners: string }>('SELECT id, owners FROM suppliers WHERE id = ?', x.supplierId);
  return usersOfSubjects(subjects, all).filter((u) => contractVisible(c, supplier, toAuthUser(u)));
}

/** Sends the reminders that are due. Returns the number sent. */
export function checkSupplierReminders(now = Date.now()): number {
  // while the vault is locked nothing can be e-mailed; claiming now would lose the reminder
  if (!vault().unlocked) return 0;
  const items = runAs(null, () => expiringItems({ days: Math.max(...SUPPLIER_REMINDER_DAYS), pastDays: 0 }, now));
  if (!items.length) return 0;
  const all = listUsers().filter((u) => u.active);
  let sent = 0;
  for (const x of items) {
    const r = plannedSupplierReminder(x);
    if (!r || !claim(x.itemId, r.key)) continue;
    // larger thresholds already passed count as sent as well
    for (const d of SUPPLIER_REMINDER_DAYS) if (d > r.threshold) claim(x.itemId, `${x.date}:${d}`);
    const event = x.kind === 'certificate' ? 'supplier.certificate_expiring' : 'supplier.notice_due';
    try {
      notify({
        event,
        text: (l) => text(l, x),
        link:
          x.kind === 'notice'
            ? `/suppliers/${encodeURIComponent(x.supplierId)}/contracts/${encodeURIComponent(x.itemId)}`
            : `/suppliers/${encodeURIComponent(x.supplierId)}`,
        recipients: recipientsOf(x, all),
        about: { kind: 'supplier', id: x.supplierId },
        inAppKey: `supplier:${x.itemId}:${r.key}`,
        externalKey: `supplier:${x.itemId}:${r.key}`,
        data: { supplierId: x.supplierId, supplier: x.supplierName, item: x.kind, itemId: x.itemId, title: x.title, date: x.date, days: x.days },
      });
      sent++;
    } catch (err) {
      logger.warn({ err, supplierId: x.supplierId }, 'supplier reminder could not be sent');
    }
  }
  return sent;
}

const COLUMNS = ['Supplier', 'Kind', 'Item', 'Date', 'Days', 'Contract owners', 'Services'];

/**
 * The built-in dataset "Suppliers: expiring" (`suppliers.expiring`): certificates that run out and notice-by dates in
 * the next 90 days and those passed in the last 30, of active suppliers. It names every supplier, so administrators
 * and auditors read it (like the cost datasets). At most hourly.
 */
export function publishSuppliersDataset(now = Date.now()): boolean {
  if (!db().get('SELECT id FROM suppliers LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', SUPPLIERS_EXPIRING_DATASET)) return false;
  const items = runAs(null, () => expiringItems({ days: 90, pastDays: 30 }, now));
  const rows: DatasetRow[] = items.map((x) => ({
    Supplier: x.supplierName,
    Kind: x.kind === 'certificate' ? 'certificate' : 'notice',
    Item: x.title,
    Date: x.date,
    Days: x.days,
    // a notice-by date names the contract's owners and the services it covers (ADR 0031); empty for certificates
    'Contract owners': x.contractOwners.join(', '),
    Services: x.services.map((s) => (s.purpose ? `${s.name}: ${s.purpose}` : s.name)).join('; '),
    _key: `${x.supplierId}/${x.itemId}`,
    _status: x.days < 0 ? 'serious' : x.days <= 30 ? 'warning' : 'good',
    _reason: x.days < 0 ? (x.kind === 'certificate' ? 'Expired' : 'Notice date passed') : x.days <= 30 ? 'Within 30 days' : '',
  }));
  publishDataset({
    key: SUPPLIERS_EXPIRING_DATASET,
    title: 'Suppliers: expiring',
    processId: 'suppliers:expiring',
    processName: 'Suppliers (built in)',
    runId: '',
    dryRun: false,
    columns: COLUMNS,
    rows,
    metrics: {
      certificates: items.filter((x) => x.kind === 'certificate' && x.days >= 0).length,
      notices: items.filter((x) => x.kind === 'notice' && x.days >= 0).length,
      passed: items.filter((x) => x.days < 0).length,
    },
    limits: {},
    staleAfterMinutes: 24 * 60 * 2,
    staleAfterFixed: true,
  });
  return true;
}

/** The job "suppliers": reminders and the dataset, at most hourly (asked every 5 minutes). */
export function runSupplierJob(now = Date.now(), force = false): { reminders: number; dataset: boolean } {
  if (!force && now - lastRun < HOUR) return { reminders: 0, dataset: false };
  lastRun = now;
  // the upgrade to 0.18 (ADR 0031): audited once, the administrators' notice opened
  try {
    finishContractScopeUpgrade();
  } catch (err) {
    logger.warn({ err }, 'the upgrade of supplier contracts could not be finished');
  }
  const reminders = checkSupplierReminders(now);
  let dataset = false;
  try {
    dataset = publishSuppliersDataset(now);
  } catch (err) {
    logger.warn({ err }, 'the dataset suppliers.expiring could not be published');
  }
  return { reminders, dataset };
}
