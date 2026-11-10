import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../../db.js';
import { logger } from '../../log.js';
import { listUsers, toAuthUser } from '../../auth/users.js';
import { samePerson } from '../../auth/assurance.js';
import { formatDateTime, t } from '../../i18n/index.js';
import { parseJson } from '../../util.js';
import { canSee, isAuthor, rightsProblem, rowOf, type CsRow } from './core.js';

/**
 * Messages about plant change sets (0.13.0, docs/NOTIFICATIONS.md, ADR 0020): `plant.change_proposed` to the people who
 * may apply a proposed change set – who sees it and manages every site it touches (and the catalogue for device
 * profiles and KPI definitions), never one of its authors – and `plant.change_decided` to its authors when someone
 * else applied, rejected or returned it, or when it expired. In the app, by e-mail and in Teams per the routes of the
 * events, with quiet hours and digests; a person's text names the change set, a channel's only who wrote it (a channel
 * is read by people who may not see the sites). Assistants' proposals are told through their AI request (mcp.request).
 */

export type ChangeSetOutcome = 'applied' | 'rejected' | 'returned' | 'expired';

const active = (): UserInfo[] => listUsers().filter((u) => u.active);
const authorsOf = (r: CsRow): string[] => parseJson<string[]>(r.authors, []);
const sitesOf = (r: CsRow): string[] => parseJson<string[]>(r.sites, []);
const opsCount = (id: string) => Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_change_ops WHERE change_set_id = ?', id)?.n ?? 0);
/** A person-written title in a message title: one line, at most 80 characters. */
const oneLine = (s: string) => {
  // eslint-disable-next-line no-control-regex -- control characters (line breaks) are the point
  const x = s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return x.length > 80 ? `${x.slice(0, 79).trimEnd()}…` : x;
};

/** Who may apply it: sees it, has the rights it needs, and wrote none of it. */
export function changeSetReviewers(r: CsRow): UserInfo[] {
  return active().filter((u) => {
    const au = toAuthUser(u);
    return !isAuthor(r, au) && canSee(r, au) && !rightsProblem(r, au);
  });
}

/** Its authors – the creator and everyone who changed an operation – except who decided. */
export function changeSetAuthors(r: CsRow, decidedBy: string | null): UserInfo[] {
  const names = authorsOf(r);
  return active().filter((u) => {
    const au = toAuthUser(u);
    return names.some((n) => samePerson(n, au)) && !(decidedBy && samePerson(decidedBy, au));
  });
}

async function send(n: Parameters<typeof import('../../notifications/service.js').notify>[0]): Promise<void> {
  const { notify } = await import('../../notifications/service.js');
  notify(n);
}

/** A change set was proposed (by a person, or an import, bulk change or rename that needs review). */
export function notifyProposed(id: string): void {
  try {
    const r = rowOf(id);
    if (!r || r.state !== 'proposed' || r.source === 'assistant') return;
    const recipients = changeSetReviewers(r);
    if (!recipients.length) return;
    const count = opsCount(r.id);
    const author = r.proposed_by ?? r.created_by;
    const where = (l: Locale) =>
      [
        ...(sitesOf(r).length ? [t(l, 'plantChange.sites', { sites: sitesOf(r).join(', ') })] : []),
        ...(Number(r.catalogue) ? [t(l, 'plantChange.catalogue')] : []),
      ].join(', ') || '–';
    void send({
      event: 'plant.change_proposed',
      recipients,
      // a person who may apply it sees every site it touches; a channel only that it waits, and who wrote it
      personal: true,
      text: (l, u) =>
        u
          ? {
              title: t(l, 'plantChange.proposedTitle', { title: oneLine(r.title) }),
              body: t(l, 'plantChange.proposedBody', { author, count, where: where(l), expires: r.expires_at ? formatDateTime(l, r.expires_at) : '–' }),
            }
          : { title: t(l, 'plantChange.proposedChannelTitle', { author }), body: t(l, 'plantChange.proposedChannelBody') },
      link: `/plant/changes/${encodeURIComponent(r.id)}`,
      inAppKey: `plant-change:${r.id}:proposed:${r.proposed_at ?? ''}`,
      externalKey: `plant-change:${r.id}:proposed:${r.proposed_at ?? ''}`,
      data: { changeSetId: r.id, source: r.source, operations: count },
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
      changeSet: r.id,
    }).catch((err) => logger.warn({ err, changeSet: id }, 'could not notify about a proposed plant change set'));
  } catch (err) {
    logger.warn({ err, changeSet: id }, 'could not notify about a proposed plant change set');
  }
}

/** A change set was decided by someone else (applied, rejected, returned to its author) or expired. */
export function notifyDecided(id: string, outcome: ChangeSetOutcome, decidedBy: string | null, comment = ''): void {
  try {
    const r = rowOf(id);
    if (!r || r.source === 'assistant') return;
    const recipients = changeSetAuthors(r, decidedBy);
    if (!recipients.length) return;
    const by = decidedBy ?? '';
    void send({
      event: 'plant.change_decided',
      recipients,
      personal: true,
      text: (l, u) =>
        u
          ? {
              title: t(l, `plantChange.decidedTitle.${outcome}`, { title: oneLine(r.title) }),
              body: [t(l, `plantChange.decidedBody.${outcome}`, { by }), comment ? t(l, 'plantChange.comment', { comment: comment.slice(0, 1000) }) : '']
                .filter(Boolean)
                .join('\n\n'),
            }
          : { title: t(l, `plantChange.decidedChannelTitle.${outcome}`, { author: r.created_by }), body: t(l, 'plantChange.decidedChannelBody') },
      link: `/plant/changes/${encodeURIComponent(r.id)}`,
      inAppKey: `plant-change:${r.id}:${outcome}:${r.updated_at}`,
      externalKey: `plant-change:${r.id}:${outcome}:${r.updated_at}`,
      data: { changeSetId: r.id, source: r.source, outcome, decidedBy: decidedBy ?? null },
    }).catch((err) => logger.warn({ err, changeSet: id }, 'could not notify about a decided plant change set'));
  } catch (err) {
    logger.warn({ err, changeSet: id }, 'could not notify about a decided plant change set');
  }
}

/** Held messages about a change set (quiet hours, digests): still waiting, still visible to the person. */
export async function registerChangeSetHeldCheck(): Promise<void> {
  const { setChangeSetCheck } = await import('../../notifications/outbox.js');
  setChangeSetCheck({
    open: (id) => rowOf(id)?.state === 'proposed',
    visible: (u, id) => {
      const r = rowOf(id);
      return !!r && canSee(r, toAuthUser(u));
    },
  });
}
