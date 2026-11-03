import { z } from 'zod';
import { KAFKA_KIND, KAFKA_TOPIC_RE, TOPIC_PREFIX_LIMITS, type TopicPrefixListing, type TopicPrefixSync } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { forbid, me } from '../auth/access.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { findUserByName } from '../auth/users.js';
import { platformPermissions } from '../auth/permissions.js';
import { platformFor } from '../monitors/platforms.js';
import { environmentValue } from '../catalogue/environments.js';
import { kafkaError, withKafka } from './client.js';

/**
 * Kafka topics by prefix (v0.4.0, docs/KAFKA.md): an application's owner chooses a Kafka platform and a prefix
 * (smo-ie.dev.), Steward lists the cluster's topics under it – read-only, with the existing client – and the chosen
 * ones become components of type "Kafka topic". "Keep in sync" remembers the prefix: new topics under it are offered on
 * the application page and in the daily summary, until they are added or dismissed. Matching is a plain startsWith –
 * no pattern is built from the prefix.
 */

export const prefixValue = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((p) => KAFKA_TOPIC_RE.test(p), 'A prefix has letters, digits, ".", "_" and "-"');

export const listInput = z.object({ platformId: z.string().min(1).max(100), prefix: prefixValue }).strict();

export const addInput = z
  .object({
    platformId: z.string().min(1).max(100),
    prefix: prefixValue,
    environment: environmentValue.default(''),
    topics: z.array(z.string().min(1).max(249)).max(TOPIC_PREFIX_LIMITS.maxTopics).default([]),
    keepInSync: z.boolean().default(false),
  })
  .strict();

export const dismissInput = z.object({ topics: z.array(z.string().min(1).max(249)).min(1).max(TOPIC_PREFIX_LIMITS.maxTopics) }).strict();

interface AppRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

interface SyncRow {
  id: string;
  application_id: string;
  platform_id: string;
  prefix: string;
  environment: string;
  offered: string;
  dismissed: string;
  checked_at: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
}

type CanEdit = (u: AuthUser | null, r: Pick<AppRow, 'id' | 'owners'>) => boolean;

async function appOf(appId: string, edit: boolean): Promise<AppRow> {
  const { getApplication, canEditApplication } = await import('../catalogue/applications.js');
  getApplication(appId); // 404 for applications the user may not see
  const a = db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE id = ?', appId)!;
  if (edit) {
    if (!(canEditApplication as CanEdit)(currentUser(), a)) forbid('change the components of this application', 'changeApplication');
    if (a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
  }
  return a;
}

/** The Kafka platform, used with the rights of `username`. */
function kafkaPlatform(username: string, platformId: string) {
  const row = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', platformId);
  if (row?.kind !== KAFKA_KIND) throw new HttpError(400, 'Choose a Kafka platform you may use', 'COMPONENT_TOPIC_PLATFORM', { id: platformId });
  try {
    return platformFor(username, platformId);
  } catch {
    throw new HttpError(400, 'Choose a Kafka platform you may use', 'COMPONENT_TOPIC_PLATFORM', { id: platformId });
  }
}

/** The cluster's topics under a prefix (sorted, at most TOPIC_PREFIX_LIMITS.maxTopics); internal topics (_…) are left out. */
export async function topicsUnder(username: string, platformId: string, prefix: string): Promise<{ topics: string[]; truncated: boolean }> {
  const { platform, secrets } = kafkaPlatform(username, platformId);
  let all: string[];
  try {
    all = await withKafka(platform, secrets, (k) => k.listTopics());
  } catch (e) {
    throw new HttpError(502, `The Kafka cluster could not be read: ${kafkaError(e)}`.slice(0, 500), 'KAFKA_LIST_FAILED', {
      detail: kafkaError(e).slice(0, 300),
    });
  }
  const under = all.filter((t) => t.startsWith(prefix) && !t.startsWith('_') && KAFKA_TOPIC_RE.test(t)).sort();
  return { topics: under.slice(0, TOPIC_PREFIX_LIMITS.maxTopics), truncated: under.length > TOPIC_PREFIX_LIMITS.maxTopics };
}

/** Topic components of the application (lower-cased names) per environment. */
function topicComponents(appId: string, environment: string): Set<string> {
  return new Set(
    db()
      .all<{ name: string }>(
        "SELECT name FROM application_components WHERE application_id = ? AND type = 'kafka-topic' AND environment = ?",
        appId,
        environment,
      )
      .map((r) => r.name.toLowerCase()),
  );
}

export async function listTopics(appId: string, input: z.infer<typeof listInput>, environment = ''): Promise<TopicPrefixListing> {
  const u = me();
  // part of adding topics: who may change the application
  await appOf(appId, true);
  const got = await topicsUnder(u.username, input.platformId, input.prefix);
  const have = topicComponents(appId, environment);
  return { prefix: input.prefix, topics: got.topics.map((name) => ({ name, added: have.has(name.toLowerCase()) })), truncated: got.truncated };
}

/**
 * Adds the chosen topics as components (each audited like a component added by hand) – only topics the cluster has under
 * the prefix; ones the application has already are skipped. `keepInSync` remembers the prefix.
 */
export async function addTopics(
  appId: string,
  input: z.infer<typeof addInput>,
): Promise<{ added: string[]; skipped: { name: string; reason: string }[]; sync: TopicPrefixSync | null }> {
  const u = me();
  const a = await appOf(appId, true);
  const { addComponent } = await import('../catalogue/components.js');
  const { canEditApplication } = await import('../catalogue/applications.js');
  const listed = input.topics.length ? new Set((await topicsUnder(u.username, input.platformId, input.prefix)).topics) : new Set<string>();
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const have = topicComponents(appId, input.environment);
  for (const name of [...new Set(input.topics)]) {
    if (!name.startsWith(input.prefix) || !listed.has(name)) {
      skipped.push({ name, reason: 'not a topic of the cluster under the prefix' });
      continue;
    }
    if (have.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'already a component' });
      continue;
    }
    try {
      addComponent(appId, { type: 'kafka-topic', name, url: '', note: '', environment: input.environment, platformId: input.platformId }, canEditApplication);
      added.push(name);
    } catch (e) {
      skipped.push({ name, reason: (e as Error).message.slice(0, 200) });
    }
  }
  let sync: TopicPrefixSync | null = null;
  const existing = db().get<SyncRow>(
    'SELECT * FROM application_topic_prefixes WHERE application_id = ? AND platform_id = ? AND prefix = ? AND environment = ?',
    appId,
    input.platformId,
    input.prefix,
    input.environment,
  );
  if (input.keepInSync && !existing) {
    const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM application_topic_prefixes WHERE application_id = ?', appId)!.n);
    if (n >= TOPIC_PREFIX_LIMITS.syncsPerApplication)
      throw new HttpError(409, `An application keeps at most ${TOPIC_PREFIX_LIMITS.syncsPerApplication} topic prefixes in sync`, 'TOPIC_PREFIX_LIMIT', {
        max: TOPIC_PREFIX_LIMITS.syncsPerApplication,
      });
    const id = newId('tpx_');
    const now = nowIso();
    // what was listed and not chosen is not offered again: the owner saw it
    const notChosen = [...listed].filter((x) => !added.includes(x) && !have.has(x.toLowerCase()));
    db().tx(() => {
      db().run(
        `INSERT INTO application_topic_prefixes (id, application_id, platform_id, prefix, environment, offered, dismissed, checked_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
        id,
        appId,
        input.platformId,
        input.prefix,
        input.environment,
        JSON.stringify(notChosen),
        listed.size ? now : null,
        u.username,
        now,
      );
      audit({
        action: 'application.topic_prefix_synced',
        entityType: 'application',
        entityId: appId,
        summary: `Kafka topics under "${input.prefix}" are kept in sync for application "${a.name}"${input.environment ? ` (${input.environment})` : ''}`,
        details: { syncId: id, platformId: input.platformId, prefix: input.prefix, environment: input.environment },
      });
    });
    sync = toSync(db().get<SyncRow>('SELECT * FROM application_topic_prefixes WHERE id = ?', id)!);
  } else if (existing) {
    // offered topics that were added now are offered no longer
    const offered = parseJson<string[]>(existing.offered, []).filter((x) => !added.includes(x));
    db().run('UPDATE application_topic_prefixes SET offered = ? WHERE id = ?', JSON.stringify(offered), existing.id);
    sync = toSync({ ...existing, offered: JSON.stringify(offered) });
  }
  if (added.length || skipped.length)
    audit({
      action: 'application.topics_added',
      entityType: 'application',
      entityId: appId,
      summary: `${added.length} Kafka topic(s) under "${input.prefix}" added to application "${a.name}"${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      details: { platformId: input.platformId, prefix: input.prefix, environment: input.environment, added, skipped },
    });
  return { added, skipped, sync };
}

/** The platform's name – only for a reader with some right on it (jobs see every name). */
function platformName(id: string): string | null {
  const u = currentUser();
  const r = db().get<{ name: string; acl: string }>('SELECT name, acl FROM platforms WHERE id = ?', id);
  if (!r) return null;
  return !u || platformPermissions(u, { id, acl: parseJson(r.acl, []) }).length ? r.name : null;
}

function toSync(r: SyncRow): TopicPrefixSync {
  return {
    id: r.id,
    applicationId: r.application_id,
    platformId: r.platform_id,
    platformName: platformName(r.platform_id),
    prefix: r.prefix,
    environment: r.environment,
    offered: parseJson<string[]>(r.offered, []),
    checkedAt: r.checked_at,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function listSyncs(appId: string): Promise<TopicPrefixSync[]> {
  await appOf(appId, false);
  return db().all<SyncRow>('SELECT * FROM application_topic_prefixes WHERE application_id = ? ORDER BY prefix, environment', appId).map(toSync);
}

function syncRow(appId: string, syncId: string): SyncRow {
  const r = db().get<SyncRow>('SELECT * FROM application_topic_prefixes WHERE id = ? AND application_id = ?', syncId, appId);
  if (!r) throw new HttpError(404, 'This topic prefix is not kept in sync for the application', 'TOPIC_PREFIX_NOT_FOUND', { id: syncId });
  return r;
}

export async function stopSync(appId: string, syncId: string): Promise<void> {
  const a = await appOf(appId, true);
  const r = syncRow(appId, syncId);
  db().tx(() => {
    db().run('DELETE FROM application_topic_prefixes WHERE id = ?', r.id);
    audit({
      action: 'application.topic_prefix_unsynced',
      entityType: 'application',
      entityId: appId,
      summary: `Kafka topics under "${r.prefix}" are no longer kept in sync for application "${a.name}"`,
      details: { syncId: r.id, platformId: r.platform_id, prefix: r.prefix, environment: r.environment },
    });
  });
}

export async function dismissTopics(appId: string, syncId: string, topics: string[]): Promise<TopicPrefixSync> {
  const a = await appOf(appId, true);
  const r = syncRow(appId, syncId);
  const drop = new Set(topics);
  const offered = parseJson<string[]>(r.offered, []).filter((x) => !drop.has(x));
  const dismissed = [...new Set([...parseJson<string[]>(r.dismissed, []), ...topics.filter((x) => x.startsWith(r.prefix))])].slice(-5000);
  db().tx(() => {
    db().run('UPDATE application_topic_prefixes SET offered = ?, dismissed = ? WHERE id = ?', JSON.stringify(offered), JSON.stringify(dismissed), r.id);
    audit({
      action: 'application.topics_dismissed',
      entityType: 'application',
      entityId: appId,
      summary: `${topics.length} Kafka topic(s) under "${r.prefix}" dismissed for application "${a.name}"`,
      details: { syncId: r.id, topics },
    });
  });
  return toSync({ ...r, offered: JSON.stringify(offered), dismissed: JSON.stringify(dismissed) });
}

/** Reads a synced prefix again with the rights of the person who set it up: offered = new topics, not components, not dismissed. */
export async function checkSync(r: SyncRow, now = Date.now()): Promise<SyncRow> {
  const at = new Date(now).toISOString();
  const before = parseJson<string[]>(r.offered, []);
  let offered = before;
  let error: string | null = null;
  try {
    const owner = findUserByName(r.created_by);
    if (!owner?.active) throw new Error(`${r.created_by} is no longer an active user – set the prefix up again`);
    const got = await topicsUnder(r.created_by, r.platform_id, r.prefix);
    const have = topicComponents(r.application_id, r.environment);
    const dismissed = new Set(parseJson<string[]>(r.dismissed, []));
    offered = got.topics.filter((x) => !have.has(x.toLowerCase()) && !dismissed.has(x));
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  db().run('UPDATE application_topic_prefixes SET offered = ?, checked_at = ?, error = ? WHERE id = ?', JSON.stringify(offered), at, error, r.id);
  const fresh = offered.filter((x) => !before.includes(x));
  if (fresh.length)
    audit({
      actor: 'system',
      action: 'application.topics_offered',
      entityType: 'application',
      entityId: r.application_id,
      summary: `${fresh.length} new Kafka topic(s) under "${r.prefix}" offered to the application`,
      details: { syncId: r.id, topics: fresh.slice(0, 100) },
    });
  return { ...r, offered: JSON.stringify(offered), checked_at: at, error };
}

export async function checkSyncNow(appId: string, syncId: string): Promise<TopicPrefixSync> {
  await appOf(appId, true);
  return toSync(await checkSync(syncRow(appId, syncId)));
}

/** The synced prefixes due for a check (every TOPIC_PREFIX_LIMITS.refreshHours); from the notification jobs. */
export async function runTopicPrefixJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<SyncRow>(`SELECT p.* FROM application_topic_prefixes p JOIN applications a ON a.id = p.application_id WHERE a.archived = 0`);
  let n = 0;
  for (const r of rows) {
    if (r.checked_at && now - Date.parse(r.checked_at) < TOPIC_PREFIX_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await checkSync(r, now);
      n++;
    } catch (err) {
      logger.warn({ err, sync: r.id }, 'checking a Kafka topic prefix failed');
    }
  }
  return n;
}

/** Offered topics of the applications a user may change (the daily summary's "New Kafka topics"). */
export function offeredFor(
  u: AuthUser,
  canEdit: CanEdit,
): { applicationId: string; applicationName: string; prefix: string; environment: string; topics: string[] }[] {
  return db()
    .all<SyncRow & { app_name: string; owners: string }>(
      `SELECT p.*, a.name AS app_name, a.owners FROM application_topic_prefixes p JOIN applications a ON a.id = p.application_id
       WHERE a.archived = 0 AND p.offered <> '[]' ORDER BY a.name, p.prefix`,
    )
    .filter((r) => canEdit(u, { id: r.application_id, owners: r.owners }))
    .map((r) => ({
      applicationId: r.application_id,
      applicationName: r.app_name,
      prefix: r.prefix,
      environment: r.environment,
      topics: parseJson<string[]>(r.offered, []),
    }))
    .filter((x) => x.topics.length > 0);
}
