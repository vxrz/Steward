import { moneyText, toMicros, volumeNoticeKinds, type CostVolumeWarning, type Locale } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { runAs } from '../auth/context.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { visibleContracts } from '../suppliers/links.js';
import { scopeInfo } from './access.js';
import { allSchedules, isVolume, payerOf, type Schedule } from './schedule-model.js';
import { VolumeUse } from './volumes.js';

/**
 * The warnings of contract volumes (0.19.0, ADR 0032 part 3, event `cost.volume`): once per schedule, period and kind,
 * to the payer's owners who see its amounts (a service's named owners and owning teams' members; a platform's managers
 * and owning teams' members), else to the administrators – like the cost budget's notice. Each recipient reads the
 * figures only when they see the payer's amounts and every service and platform that books to the volume, and the
 * contract's title only when they may see the contract. Kept apart from volumes.ts, which the cost plan reads.
 */

let checked = 0;

function claim(scheduleId: string, periodFrom: string, kind: CostVolumeWarning): boolean {
  return (
    db().run(
      'INSERT INTO cost_volume_notices (schedule_id, period_from, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      scheduleId,
      periodFrom,
      kind,
      nowIso(),
    ).changes === 1
  );
}

/**
 * Sends the volume warnings that are due (at most hourly): per volume schedule of a payer that is not archived, the
 * warnings of its current period that a notice goes out for now (volumeNoticeKinds), once per schedule, period and
 * kind. Returns the number of notices sent.
 */
export function checkVolumeNotices(now = Date.now(), force = false): number {
  if (!force && now - checked < 3600_000) return 0;
  // while the vault is locked nothing can be e-mailed; claiming now would lose the notice
  if (!vault().unlocked) return 0;
  checked = now;
  const list = allSchedules().filter(isVolume);
  if (!list.length) return 0;
  const vu = VolumeUse.forSchedules(list, now);
  const archived = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM services WHERE archived = 1')
      .map((r) => r.id),
  );
  const users = listUsers().filter((u) => u.active);
  let sent = 0;
  for (const s of list) {
    const payer = payerOf(s.row);
    if (payer.kind === 'service' && archived.has(payer.id)) continue;
    const x = vu.evaluate(s);
    if (!x) continue;
    for (const kind of volumeNoticeKinds(x.warnings, x.period, x.estimate, vu.today)) {
      if (!claim(s.row.id, x.period.from, kind)) continue;
      try {
        sendNotice(s, payer, kind, users, now);
        sent++;
      } catch (err) {
        logger.warn({ err, scheduleId: s.row.id }, 'volume notice could not be sent');
      }
    }
  }
  return sent;
}

function sendNotice(
  s: Schedule,
  payer: { kind: 'service' | 'platform'; id: string },
  kind: CostVolumeWarning,
  users: ReturnType<typeof listUsers>,
  now: number,
): void {
  // the payer's owners who see its amounts; else the administrators
  const owners = users.filter((u) => {
    if (u.roles.includes('admin')) return false;
    const i = scopeInfo(payer.kind, payer.id, toAuthUser(u));
    return !!i?.owner && i.amounts;
  });
  const recipients = owners.length ? owners : users.filter((u) => u.roles.includes('admin'));
  if (!recipients.length) return;
  const payerName = scopeInfo(payer.kind, payer.id, null)?.name ?? payer.id;
  const link = payer.kind === 'service' ? `/services/${encodeURIComponent(payer.id)}/costs` : `/platforms/${encodeURIComponent(payer.id)}?tab=costPlan`;
  const views = new Map(
    recipients.map((u) => {
      const au = toAuthUser(u);
      const info = scopeInfo(payer.kind, payer.id, au);
      // the recipient's own view: figures only when they see the amounts and every service and platform that books to it
      const st = runAs(au, () => VolumeUse.forSchedules([s], now).status(s, { amounts: !!info?.amounts }));
      return [u.id, { st, contract: visibleContracts([s.contract.id], au).has(s.contract.id) }];
    }),
  );
  const money = (v: string | null) => (v === null ? '' : moneyText(toMicros(v) ?? 0, s.row.currency));
  const text = (l: Locale, u?: { id: string }) => {
    const view = u ? views.get(u.id) : undefined;
    const title = view?.contract ? `${s.contract.title} – ${s.row.title}` : s.row.title;
    const st = view?.st;
    const lines = [t(l, `costVolume.state.${kind}`, { title, payer: payerName })];
    if (st && st.used !== null) {
      lines.push(
        t(l, 'costVolume.figures', {
          from: st.period.from,
          to: st.period.to,
          used: money(st.used),
          amount: money(st.amount),
          pct: (st.sharePct ?? 0).toLocaleString(l),
        }),
      );
      if (st.minimum !== null && st.committed === 'minimum') lines.push(t(l, 'costVolume.minimum', { minimum: money(st.minimum) }));
      if (st.expectedAtEnd !== null) lines.push(t(l, 'costVolume.estimate', { expected: money(st.expectedAtEnd), to: st.period.to }));
      if (st.runsOutOn) lines.push(t(l, 'costVolume.runsOutOn', { date: st.runsOutOn }));
      lines.push(t(l, 'costVolume.estimateNote'));
    } else lines.push(t(l, 'costVolume.stateOnly'));
    return { title: t(l, `costVolume.title.${kind}`, { title: titleName(title) }), body: lines.join('\n') };
  };
  notify({
    event: 'cost.volume',
    personal: true,
    text: (l, u) => text(l, u),
    link,
    recipients,
    about: { kind: payer.kind, id: payer.id },
    inAppKey: `cost.volume:${s.row.id}:${kind}`,
    externalKey: `cost.volume:${s.row.id}:${kind}`,
    data: { scheduleId: s.row.id, payerKind: payer.kind, payerId: payer.id, payer: payerName, warning: kind, currency: s.row.currency },
  });
}
