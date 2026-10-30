import { EnvHttpProxyAgent, fetch } from 'undici';
import { assertNetAllowed, assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { BRAND, MONITOR_STATUS_CODE, fillPlaceholders, type CauseRef, type MonitorStatus, type OutputDef, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { runAs } from '../auth/context.js';
import { findUserByName, listUsers, toAuthUser } from '../auth/users.js';
import { matches } from '../auth/permissions.js';
import { notify } from '../notifications/service.js';
import { permissionsFor } from '../processes/service.js';
import { platformRequest } from '../platforms/http.js';
import { startRun } from '../engine/runner.js';
import { evalExpr } from '../engine/expr.js';
import { platformFor } from './platforms.js';
import { zabbixSend } from './zabbix.js';
import { monitorPermissions, type LoadedMonitor } from './model.js';
import { t, type MessageKey } from '../i18n/index.js';
import { checkMessage, monitorVisibility, redactCauses, type MonitorVisibility } from './redact.js';
import { teamsCard, type OutgoingMessage } from '../notifications/channels.js';
import { absoluteLink } from '../notifications/settings.js';
import { defaultLocale } from '../notifications/service.js';

/**
 * Outputs send monitor and check statuses to people and other systems.
 * De-duplication: per output and subject (the monitor, or one check) the last
 * delivered status is stored; "change" outputs send when the current status
 * differs from it (so a failed delivery is retried with the next evaluation and
 * nothing is sent twice after a restart); "every" outputs send after each
 * evaluation, at most every minIntervalSeconds.
 */

export interface OutEvent {
  /** '' = the monitor itself */
  subject: string;
  level: 'monitor' | 'check';
  status: MonitorStatus;
  previous: MonitorStatus | null;
  since: string | null;
  message: string;
  causedBy: CauseRef[];
  ts: string;
  monitor: { id: string; key: string; name: string; status: MonitorStatus };
  check?: { id: string; key: string; name: string; type: string };
  durationMs?: number | null;
  value?: unknown;
}

export interface Subject {
  event: Omit<OutEvent, 'previous'>;
  /** check subjects: has a failing parent that explains the failure */
  dependent: boolean;
}

interface OutState {
  last_status: MonitorStatus | null;
  last_sent_at: string | null;
  last_error: string | null;
  last_run_id: string | null;
}

const ACTIVE_RUN = ['running', 'waiting', 'queued', 'interrupted'];
/** Failed deliveries are retried at most this often. */
const RETRY_MS = 60000;
const lastAttempt = new Map<string, number>();
/** First time a notification was held back (holdSeconds). */
const holding = new Map<string, number>();
const proxy = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);

export const includeOf = (o: OutputDef) => o.include ?? (o.type === 'notification' || o.type === 'process' ? 'monitor' : 'all');
const suppressOf = (o: OutputDef) => o.suppressDependents ?? (o.type === 'notification' || o.type === 'process');
const statusesOf = (o: OutputDef): MonitorStatus[] | undefined => o.statuses ?? (o.type === 'process' ? ['down'] : undefined);
const peopleFacing = (o: OutputDef) => o.type === 'notification' || o.type === 'process';

function outState(mid: string, oid: string, subject: string): OutState | undefined {
  return db().get<OutState>(
    'SELECT last_status, last_sent_at, last_error, last_run_id FROM monitor_output_state WHERE monitor_id = ? AND output_id = ? AND subject = ?',
    mid,
    oid,
    subject,
  );
}

function saveOutState(mid: string, oid: string, subject: string, patch: Partial<OutState>): void {
  const cur = outState(mid, oid, subject) ?? { last_status: null, last_sent_at: null, last_error: null, last_run_id: null };
  const n = { ...cur, ...patch };
  db().run(
    `INSERT INTO monitor_output_state (monitor_id, output_id, subject, last_status, last_sent_at, last_error, last_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (monitor_id, output_id, subject) DO UPDATE SET last_status = excluded.last_status, last_sent_at = excluded.last_sent_at,
       last_error = excluded.last_error, last_run_id = excluded.last_run_id`,
    mid,
    oid,
    subject,
    n.last_status,
    n.last_sent_at,
    n.last_error,
    n.last_run_id,
  );
}

export interface DispatchContext {
  monitor: LoadedMonitor;
  subjects: Subject[];
  maintenance: boolean;
  acknowledged: boolean;
  now: number;
}

/** Decides per output and subject what to send, sends it and records the outcome. */
export async function dispatchOutputs(ctx: DispatchContext): Promise<void> {
  const m = ctx.monitor;
  const jobs: Promise<void>[] = [];
  for (const o of m.def.outputs) {
    if (!o.enabled) continue;
    const include = includeOf(o);
    const statuses = statusesOf(o);
    const send: OutEvent[] = [];
    for (const s of ctx.subjects) {
      const e = s.event;
      if (e.level === 'monitor' ? include === 'checks' : include === 'monitor') continue;
      if (e.level === 'check' && o.checks?.length && !o.checks.includes(e.subject)) continue;
      const st = outState(m.id, o.id, e.subject);
      const prev = st?.last_status ?? null;
      const changed = e.status !== prev;
      const key = `${m.id}|${o.id}|${e.subject}`;
      if (o.on === 'every') {
        const due = !st?.last_sent_at || ctx.now - Date.parse(st.last_sent_at) >= (o.minIntervalSeconds ?? 60) * 1000;
        if (!changed && !due) continue;
      } else if (!changed) {
        holding.delete(key);
        continue;
      }
      // reasons to record the status without sending
      let quiet: string | null = null;
      if (statuses && !statuses.includes(e.status)) quiet = 'status not selected';
      else if (peopleFacing(o) && (ctx.maintenance || e.status === 'maintenance')) quiet = 'maintenance window';
      else if (peopleFacing(o) && e.status === 'up' && prev !== 'down' && prev !== 'degraded') quiet = 'nothing to recover from';
      else if (peopleFacing(o) && e.status === 'degraded' && prev === null) quiet = 'first status';
      else if (peopleFacing(o) && !statuses && (e.status === 'unknown' || e.status === 'blocked')) quiet = 'not a confirmed problem';
      else if (peopleFacing(o) && ctx.acknowledged && e.status !== 'up') quiet = 'acknowledged';
      else if (e.level === 'check' && suppressOf(o) && s.dependent) quiet = 'caused by a failing parent';
      else if (o.type === 'gatus' && e.status === 'maintenance') quiet = 'maintenance window';
      if (quiet) {
        if (changed) saveOutState(m.id, o.id, e.subject, { last_status: e.status });
        holding.delete(key);
        continue;
      }
      if (o.type === 'notification' && (o.holdSeconds ?? 0) > 0 && changed && e.status !== 'up') {
        const first = holding.get(key) ?? ctx.now;
        holding.set(key, first);
        if (ctx.now - first < o.holdSeconds! * 1000) continue;
      }
      holding.delete(key);
      const tried = lastAttempt.get(key);
      if (st?.last_error && tried && ctx.now - tried < RETRY_MS && changed && o.on === 'change') continue;
      send.push({ ...e, previous: prev });
    }
    if (!send.length) continue;
    jobs.push(
      deliver(o, m, send).then(
        (runIds) => {
          const ts = new Date(ctx.now).toISOString();
          send.forEach((e, i) => {
            saveOutState(m.id, o.id, e.subject, {
              last_status: e.status,
              last_sent_at: ts,
              last_error: null,
              ...(runIds?.[i] ? { last_run_id: runIds[i] } : {}),
            });
            lastAttempt.delete(`${m.id}|${o.id}|${e.subject}`);
          });
        },
        (err) => {
          const msg = String((err as Error).message ?? err).slice(0, 500);
          logger.warn({ monitor: m.key, output: o.id, type: o.type, err: msg }, 'monitor output failed');
          for (const e of send) {
            lastAttempt.set(`${m.id}|${o.id}|${e.subject}`, ctx.now);
            saveOutState(m.id, o.id, e.subject, { last_error: msg, ...(o.on === 'every' ? { last_sent_at: new Date(ctx.now).toISOString() } : {}) });
          }
        },
      ),
    );
  }
  await Promise.all(jobs);
}

/** Subjects with a hold timer running (the engine re-evaluates them). */
export const heldMonitors = (): Set<string> => new Set([...holding.keys()].map((k) => k.split('|')[0]!));

export function resetOutputState(): void {
  holding.clear();
  lastAttempt.clear();
}

// ---------- delivery ----------

function placeholders(m: LoadedMonitor, e: OutEvent) {
  return {
    monitor: { key: m.key, name: m.name, id: m.id, status: e.monitor.status },
    check: e.check ? { id: e.check.id, key: e.check.key, name: e.check.name, type: e.check.type } : { id: '', key: '', name: '', type: '' },
  };
}

function payload(e: OutEvent) {
  return {
    level: e.level,
    status: e.status,
    statusCode: MONITOR_STATUS_CODE[e.status],
    previous: e.previous,
    since: e.since,
    ts: e.ts,
    message: e.message,
    rootCauses: e.causedBy,
    monitor: e.monitor,
    check: e.check ?? null,
    durationMs: e.durationMs ?? null,
    value: e.value ?? null,
  };
}

/** An event as someone who may view only some monitors may see it (sub-monitors: see redact.ts). */
function eventFor(m: LoadedMonitor, e: OutEvent, canView: MonitorVisibility): OutEvent {
  const def = e.check?.type === 'monitor' ? m.def.checks.find((c) => c.id === e.check!.id) : undefined;
  const sub = def?.type === 'monitor' ? def.monitor : undefined;
  return { ...e, causedBy: redactCauses(e.causedBy, canView), message: sub ? checkMessage(e.message, e.status, sub, canView) : e.message };
}

/** Outputs to other systems act for the monitor owner: they carry what the owner may view. */
function ownerView(m: LoadedMonitor): MonitorVisibility {
  const owner = findUserByName(m.owner);
  return monitorVisibility(owner?.active ? toAuthUser(owner) : null);
}

async function deliver(o: OutputDef, m: LoadedMonitor, events: OutEvent[]): Promise<(string | undefined)[] | void> {
  if (o.type === 'webhook' || o.type === 'process') {
    const canView = ownerView(m);
    events = events.map((e) => eventFor(m, e, canView));
  }
  switch (o.type) {
    case 'notification':
      return void sendNotifications(o, m, events);
    case 'webhook':
      return void (await sendWebhook(o, m, events));
    case 'gatus':
      return void (await sendGatus(o, m, events));
    case 'zabbix':
      return void (await sendZabbix(o, m, events));
    case 'process':
      return startProcesses(o, m, events);
  }
}

const causeText = (c: CauseRef) => `${c.monitorName} › ${c.checkName}`;

function recipients(o: Extract<OutputDef, { type: 'notification' }>, m: LoadedMonitor): UserInfo[] {
  const all = listUsers().filter((u) => u.active);
  const acl = (() => {
    const r = db().get<{ acl: string }>('SELECT acl FROM monitors WHERE id = ?', m.id);
    try {
      return JSON.parse(r?.acl ?? '[]');
    } catch {
      return [];
    }
  })();
  return all.filter((u) => {
    const au = toAuthUser(u);
    const isOwner = u.username.toLowerCase() === m.owner.toLowerCase();
    if (!isOwner && !o.subscribers.some((s) => matches(au, s))) return false;
    return monitorPermissions(au, { owner: m.owner, acl }).includes('view');
  });
}

/**
 * Each recipient reads only the sub-monitors they may view; channel posts (Teams, webhook) only what
 * every recipient may view.
 */
function sendNotifications(o: Extract<OutputDef, { type: 'notification' }>, m: LoadedMonitor, events: OutEvent[]): void {
  const to = recipients(o, m);
  const views = new Map(to.map((u) => [u.id, monitorVisibility(toAuthUser(u))]));
  const everyone: MonitorVisibility = (id) => to.length > 0 && to.every((u) => views.get(u.id)!(id));
  for (const e of events) {
    const where = e.level === 'monitor' ? m.name : `${m.name} › ${e.check?.name}`;
    notify({
      event: 'monitor.status',
      personal: true,
      text: (locale, u) => {
        const v = eventFor(m, e, (u && views.get(u.id)) || everyone);
        const causes = v.causedBy.map((c) => (c.hidden ? t(locale, 'monitor.hiddenMonitor') : c.monitorId === m.id ? c.checkName : causeText(c))).join(', ');
        return {
          title: t(locale, `monitor.${e.status}` as MessageKey, { where }),
          body: `${causes ? t(locale, 'monitor.rootCause', { causes }) + ' ' : ''}${v.message}`.slice(0, 800),
        };
      },
      link: `/monitors/${m.id}${e.check ? `?check=${encodeURIComponent(e.check.id)}` : ''}`,
      recipients: to,
      inAppKey: `monitor:${m.id}:${e.subject}:${e.status}:${e.since ?? e.ts}`,
      externalKey: `monitor:${m.id}:${e.subject}:${e.status}:${e.since ?? e.ts}`,
      data: payload(eventFor(m, e, everyone)),
    });
  }
}

/** At most this many Teams cards per output and evaluation (one per status change); the rest are left out. */
const TEAMS_MAX_CARDS = 10;

/** A status change as a Teams message in the default language, like the "monitor.status" notification. */
function teamsMessage(m: LoadedMonitor, e: OutEvent): OutgoingMessage {
  const locale = defaultLocale();
  const where = e.level === 'monitor' ? m.name : `${m.name} › ${e.check?.name}`;
  const causes = e.causedBy.map((c) => (c.hidden ? t(locale, 'monitor.hiddenMonitor') : c.monitorId === m.id ? c.checkName : causeText(c))).join(', ');
  return {
    event: 'monitor.status',
    title: t(locale, `monitor.${e.status}` as MessageKey, { where }),
    body: `${causes ? t(locale, 'monitor.rootCause', { causes }) + ' ' : ''}${e.message}`.slice(0, 800),
    locale,
    link: absoluteLink(`/monitors/${m.id}${e.check ? `?check=${encodeURIComponent(e.check.id)}` : ''}`),
    ts: e.ts,
    data: payload(e),
  };
}

async function postTo(url: string, body: unknown): Promise<void> {
  await assertOutboundAllowed(url, outboundContext());
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BRAND.slug },
    body: JSON.stringify(body),
    dispatcher: proxy,
    signal: AbortSignal.timeout(15000),
  });
  await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} from the webhook`);
}

async function sendWebhook(o: Extract<OutputDef, { type: 'webhook' }>, m: LoadedMonitor, events: OutEvent[]): Promise<void> {
  if (o.format === 'teams') return sendTeamsCards(o, m, events);
  const body = { source: BRAND.slug, monitor: { id: m.id, key: m.key, name: m.name }, events: events.map(payload) };
  if (o.platform) {
    const { platform, secrets } = platformFor(m.owner, o.platform);
    const r = await platformRequest(
      platform,
      secrets,
      { method: 'POST', url: fillPlaceholders(o.path || '/', placeholders(m, events[0]!)), body, bodyType: 'json' },
      AbortSignal.timeout(15000),
    );
    if (!r.ok) throw new Error(`HTTP ${r.status} from "${platform.name}"`);
    return;
  }
  await postTo(o.url!, body);
}

/**
 * Adaptive Cards to a Teams channel (#130): the output names a "Microsoft Teams channel" platform, whose credential
 * `webhookUrl` (encrypted like every credential) is the Workflows URL. Saving refuses anything else.
 */
async function sendTeamsCards(o: Extract<OutputDef, { type: 'webhook' }>, m: LoadedMonitor, events: OutEvent[]): Promise<void> {
  const { platform, secrets } = platformFor(m.owner, o.platform ?? '');
  if (platform.kind !== 'teams') throw new Error(`Platform "${platform.name}" is not a Microsoft Teams channel`);
  if (!secrets.webhookUrl) throw new Error(`Platform "${platform.name}" has no credential "webhookUrl" (the Teams Workflows URL)`);
  for (const e of events.slice(0, TEAMS_MAX_CARDS)) await postTo(secrets.webhookUrl, teamsCard(teamsMessage(m, e)));
}

async function sendGatus(o: Extract<OutputDef, { type: 'gatus' }>, m: LoadedMonitor, events: OutEvent[]): Promise<void> {
  const { platform, secrets } = platformFor(m.owner, o.platform);
  const token = secrets[o.tokenSecret || 'externalToken'];
  if (!token) throw new Error(`Platform "${platform.name}" has no credential "${o.tokenSecret || 'externalToken'}" (external endpoint token)`);
  for (const e of events) {
    const key = fillPlaceholders(o.endpointKey, placeholders(m, e));
    const ok = e.status === 'up' || e.status === 'degraded';
    const r = await platformRequest(
      platform,
      secrets,
      {
        method: 'POST',
        url: `/api/v1/endpoints/${encodeURIComponent(key)}/external`,
        query: {
          success: String(ok),
          ...(ok ? {} : { error: e.message.slice(0, 300) }),
          ...(e.durationMs ? { duration: `${Math.round(e.durationMs)}ms` } : {}),
        },
        headers: { authorization: `Bearer ${token}` },
      },
      AbortSignal.timeout(15000),
    );
    if (!r.ok) throw new Error(`Gatus answered HTTP ${r.status} for external endpoint "${key}"`);
  }
}

export const DEFAULT_ZABBIX_KEYS = { monitor: 'steward.monitor.status[${monitor.key}]', check: 'steward.check.status[${monitor.key},${check.id}]' };

async function sendZabbix(o: Extract<OutputDef, { type: 'zabbix' }>, m: LoadedMonitor, events: OutEvent[]): Promise<void> {
  const { platform, secrets } = platformFor(m.owner, o.platform);
  const vars = platform.config.variables ?? {};
  const items = events.map((e) => {
    const ph = placeholders(m, e);
    const host = fillPlaceholders(o.host || String(vars.host ?? ''), ph);
    if (!host) throw new Error('No Zabbix host name: set "host" on the output or the variable "host" on the platform');
    const key = fillPlaceholders(e.level === 'monitor' ? (o.itemKeyMonitor ?? DEFAULT_ZABBIX_KEYS.monitor) : (o.itemKeyCheck ?? DEFAULT_ZABBIX_KEYS.check), ph);
    const ms = Date.parse(e.ts);
    return { host, key, value: o.value === 'text' ? e.status : String(MONITOR_STATUS_CODE[e.status]), clock: Math.floor(ms / 1000), ns: (ms % 1000) * 1e6 };
  });
  if (o.via === 'api') {
    const path = String(vars.apiPath || '/api_jsonrpc.php');
    const r = await platformRequest(
      platform,
      secrets,
      { method: 'POST', url: path, body: { jsonrpc: '2.0', method: 'history.push', params: items, id: 1 }, bodyType: 'json' },
      AbortSignal.timeout(15000),
    );
    const b = r.body as { result?: { response?: string; data?: { itemid?: string; error?: string }[] }; error?: { message?: string; data?: string } } | null;
    if (!r.ok) throw new Error(`Zabbix API answered HTTP ${r.status}`);
    if (b?.error) throw new Error(`Zabbix API: ${b.error.message ?? ''} ${b.error.data ?? ''}`.trim());
    const failed = (b?.result?.data ?? []).map((d, i) => (d.error ? `${items[i]?.key}: ${d.error}` : null)).filter(Boolean);
    if (failed.length) throw new Error(`Zabbix rejected ${failed.length} of ${items.length} values – ${failed.slice(0, 3).join('; ')}`);
    return;
  }
  const host = String(vars.trapperHost || safeHost(platform.baseUrl));
  const port = Number(vars.trapperPort || 10051);
  if (!host) throw new Error('No trapper host: set the platform variable "trapperHost"');
  await assertNetAllowed(host, port, outboundContext());
  const r = await zabbixSend(host, port, items);
  if (r.failed > 0 || r.processed < items.length) {
    throw new Error(
      `Zabbix processed ${r.processed} of ${items.length} values (failed: ${r.failed}) – check the host name, the item keys and that the items are of type "Zabbix trapper"`,
    );
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function startProcesses(o: Extract<OutputDef, { type: 'process' }>, m: LoadedMonitor, events: OutEvent[]): Promise<(string | undefined)[]> {
  const owner = findUserByName(m.owner);
  if (!owner || !owner.active) throw new Error(`the monitor owner ${m.owner} is missing or deactivated`);
  const user = toAuthUser(owner);
  const ids: (string | undefined)[] = [];
  for (const e of events) {
    const prev = outState(m.id, o.id, e.subject)?.last_run_id;
    if (prev) {
      const st = db().get<{ status: string }>('SELECT status FROM runs WHERE id = ?', prev)?.status;
      if (st && ACTIVE_RUN.includes(st)) {
        ids.push(prev);
        continue;
      }
    }
    const scope = { monitor: e.monitor, check: e.check ?? null, event: payload(e) };
    const inputs: Record<string, unknown> = {};
    for (const [name, expr] of Object.entries(o.inputs)) {
      try {
        const v = await evalExpr(expr, scope, {}, { timeoutMs: 1000, maxDepth: 200 });
        if (v !== undefined) inputs[name] = v;
      } catch (err) {
        throw new Error(`input mapping for "${name}" failed: ${(err as Error).message}`);
      }
    }
    const runId = await runAs(user, () => {
      if (!permissionsFor(o.processId).includes('run')) throw new Error(`${m.owner} may not run process ${o.processId}`);
      return startRun(
        { processId: o.processId, inputs, bindings: o.bindings, dryRun: o.dryRun },
        { trigger: 'monitor', actor: m.owner, webhook: { triggerId: m.id, triggerName: m.name, output: o.id } },
      );
    });
    ids.push(runId);
    logger.info({ monitor: m.key, output: o.id, runId }, 'monitor output started a run');
  }
  return ids;
}
