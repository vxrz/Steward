import {
  AWS_KIND,
  AWS_LIMITS,
  AWS_REGION_RE,
  COST_LIMITS,
  type AwsCostMonth,
  type AwsIamUser,
  type AwsReadout,
  type AwsResource,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { HttpError, parseJson } from '../util.js';
import { platformFor } from '../monitors/platforms.js';
import { AwsClient, CE_REGION, IAM_REGION, homeRegion, parseArn } from './client.js';

/**
 * AWS accounts (#116). One platform is one AWS account (optionally reached by assuming a role). Application
 * components of type "Cloud account" name the platform; their name is the value of the application tag (variable
 * tagKey, default "application"): `application=shop` links every resource with that tag to the component.
 *
 * What an account answers is read once per account and shared by all its components (table aws_account_cache):
 *   resources  Resource Groups Tagging API, every region in the variable regions      every 6 hours
 *   iam        IAM users with their tags and access keys (age, last use)               every 6 hours
 *   costs      Cost Explorer, unblended costs per month by the tag and by service      once a day (it charges per call)
 */

type Part = 'resources' | 'iam' | 'costs';

interface CacheRow {
  read_at: string;
  data: string | null;
  error: string | null;
}

interface ResourcesData {
  account: string;
  regions: string[];
  items: AwsResource[];
  warnings: string[];
}
interface IamData {
  users: (AwsIamUser & { tags: Record<string, string> })[];
}
interface CostsData {
  byTag: { month: string; tag: string; amount: number; unit: string }[];
  byService: { month: string; service: string; amount: number; unit: string }[];
  /** Per month, tag value and service (0.9.0, #226); missing in a cache written before */
  lines?: { month: string; tag: string; service: string; amount: string; unit: string }[];
}

/** Regions (variable regions, comma-separated; default the platform's region) and the tag key (variable tagKey). */
export function accountSettings(p: Platform): { regions: string[]; tagKey: string } {
  const raw = String(p.config.variables?.regions ?? '')
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const regions = [...new Set(raw.length ? raw : [homeRegion(p)])].filter((r) => AWS_REGION_RE.test(r)).slice(0, 30);
  const tagKey = String(p.config.variables?.tagKey ?? '').trim() || 'application';
  if (tagKey.length > 128) throw new HttpError(400, 'The tag key (variable tagKey) has at most 128 characters', 'AWS_TAG_KEY');
  return { regions: regions.length ? regions : [homeRegion(p)], tagKey };
}

const inflight = new Map<string, Promise<unknown>>();

/** The shared read of one part of an account: fresh enough from the cache, or read now (one read at a time per part). */
async function accountPart<T>(
  c: AwsClient,
  part: Part,
  maxAgeMs: number,
  now: number,
  read: () => Promise<T>,
): Promise<{ data: T | null; readAt: string | null; error: string | null }> {
  const id = c.p.id;
  const row = db().get<CacheRow>('SELECT read_at, data, error FROM aws_account_cache WHERE platform_id = ? AND part = ?', id, part);
  const age = row ? now - Date.parse(row.read_at) : -1;
  // (a read stamped later than now – a clock change – counts as stale)
  if (row && age >= 0 && age < maxAgeMs) return { data: parseJson<T | null>(row.data, null), readAt: row.read_at, error: row.error };
  const key = `${id}:${part}`;
  let p = inflight.get(key) as Promise<{ data: T | null; readAt: string | null; error: string | null }> | undefined;
  if (!p) {
    p = (async () => {
      const at = new Date(now).toISOString();
      try {
        const data = await read();
        db().run(
          `INSERT INTO aws_account_cache (platform_id, part, read_at, data, error) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (platform_id, part) DO UPDATE SET read_at = excluded.read_at, data = excluded.data, error = NULL`,
          id,
          part,
          at,
          JSON.stringify(data),
        );
        return { data, readAt: at, error: null };
      } catch (e) {
        const error = (e as Error).message.slice(0, 500);
        // keep what was read before, with the reason the new read failed
        db().run(
          `INSERT INTO aws_account_cache (platform_id, part, read_at, data, error) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (platform_id, part) DO UPDATE SET read_at = excluded.read_at, error = excluded.error`,
          id,
          part,
          at,
          row?.data ?? null,
          error,
        );
        return { data: parseJson<T | null>(row?.data ?? null, null), readAt: at, error };
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function readResources(c: AwsClient, regions: string[], tagKey: string): Promise<ResourcesData> {
  const { account } = await c.callerIdentity();
  const items: AwsResource[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    try {
      for (const r of await c.taggedResources(region, tagKey, AWS_LIMITS.maxResources)) {
        // global resources (S3 buckets) show up in every region
        if (seen.has(r.arn)) continue;
        seen.add(r.arn);
        const a = parseArn(r.arn);
        items.push({ arn: r.arn, service: a?.service ?? '', type: a?.type ?? '', name: a?.name ?? r.arn, region: a?.region ?? '', tags: r.tags });
      }
    } catch (e) {
      warnings.push(`${region}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  if (warnings.length === regions.length) throw new Error(warnings.join('; '));
  return { account, regions, items, warnings };
}

/** 12 months and the current one so far: the readout shows the last AWS_LIMITS.costMonths, the cost model all (#226). */
function costWindow(now: number): { start: string; end: string } {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - COST_LIMITS.months, 1));
  // End is exclusive: tomorrow (UTC) includes today so far
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The account's costs: from the cache when read within AWS_LIMITS.costHours, else read now (one request series) – and
 * then written into the cost model (#226, costs/sources.ts), so the component readout and the costs pages show the
 * same figures.
 */
async function accountCosts(client: AwsClient, tagKey: string, actor: string, now: number, maxAgeMs = AWS_LIMITS.costHours * 3_600_000) {
  return accountPart(client, 'costs', maxAgeMs, now, async () => {
    const data = (await client.costs({ ...costWindow(now), tagKey })) as CostsData;
    try {
      const { ingestAws } = await import('../costs/sources.js');
      ingestAws(client.p, data.lines ?? [], tagKey, actor, now);
    } catch (err) {
      logger.warn({ err, platform: client.p.id }, 'AWS costs not written into the cost model');
    }
    return data;
  });
}

/** The cost job (#226): the account's costs once a day (Cost Explorer charges per request), also without components. */
export async function readAwsCosts(platformId: string, actor: string, now = Date.now()): Promise<{ error: string | null; readAt: string | null }> {
  const { platform, secrets } = platformFor(actor, platformId);
  if (platform.kind !== AWS_KIND) throw new Error(`"${platform.name}" is not an AWS account`);
  const { tagKey } = accountSettings(platform);
  const r = await accountCosts(new AwsClient(platform, secrets), tagKey, actor, now);
  return { error: r.error, readAt: r.readAt };
}

/** Reads the cloud-account component now (the shared account reads only when stale, or with `force`). */
export async function refreshAwsComponent(componentId: string, actor: string, o: { now?: number; force?: boolean } = {}): Promise<AwsReadout> {
  const now = o.now ?? Date.now();
  const c = db().get<{ id: string; application_id: string; name: string; platform_id: string | null; aws_state: string | null }>(
    "SELECT id, application_id, name, platform_id, aws_state FROM application_components WHERE id = ? AND type = 'cloud-account'",
    componentId,
  );
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.platform_id) throw new HttpError(400, 'Choose the AWS platform of the cloud account first', 'COMPONENT_AWS_REQUIRED');
  const at = new Date(now).toISOString();
  const before = parseJson<AwsReadout | null>(c.aws_state, null);
  let readout: AwsReadout;
  try {
    const { platform, secrets } = platformFor(actor, c.platform_id);
    if (platform.kind !== AWS_KIND) throw new Error(`"${platform.name}" is not an AWS account`);
    const { regions, tagKey } = accountSettings(platform);
    const client = new AwsClient(platform, secrets);
    const fresh = o.force ? 0 : AWS_LIMITS.refreshHours * 3_600_000;
    const res = await accountPart(client, 'resources', fresh, now, () => readResources(client, regions, tagKey));
    if (!res.data) throw new Error(res.error ?? 'nothing read');
    const iam = await accountPart(client, 'iam', fresh, now, async () => ({ users: (await client.iamUsers()).map(toUser) }) satisfies IamData);
    // costs: once a day even on "Read now" – Cost Explorer charges every request
    const costs = await accountCosts(client, tagKey, actor, now);
    const mine = res.data.items.filter((r) => r.tags[tagKey] === c.name);
    const services: Record<string, number> = {};
    for (const r of mine) services[r.service] = (services[r.service] ?? 0) + 1;
    const first = new Date(now);
    const oldest = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - (AWS_LIMITS.costMonths - 1), 1)).toISOString().slice(0, 7);
    const months: AwsCostMonth[] = (costs.data?.byTag ?? [])
      .filter((x) => x.tag === c.name && x.month >= oldest)
      .map((x) => ({ month: x.month, amount: round2(x.amount), currency: x.unit }));
    readout = {
      readAt: at,
      // a failed read of the account shows its reason, with the resources of the last read
      error: res.error,
      account: res.data.account,
      tagKey,
      tagValue: c.name,
      regions: res.data.regions,
      resources: mine.sort((a, b) => (a.service + a.type + a.name < b.service + b.type + b.name ? -1 : 1)),
      services,
      costs: { readAt: costs.readAt, error: costs.error, months },
      users: (iam.data?.users ?? []).filter((u) => u.tags[tagKey] === c.name).map(({ tags: _tags, ...u }) => u),
      warnings: [...res.data.warnings, ...(iam.error ? [`IAM: ${iam.error}`] : [])],
    };
  } catch (e) {
    readout = {
      ...(before ?? {
        account: null,
        tagKey: 'application',
        tagValue: c.name,
        regions: [],
        resources: [],
        services: {},
        costs: { readAt: null, error: null, months: [] },
        users: [],
        warnings: [],
      }),
      readAt: at,
      error: (e as Error).message.slice(0, 500),
    };
  }
  db().run('UPDATE application_components SET aws_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  // resources that came or went are worth a line in the application's history
  if (!readout.error && before && !before.error) {
    const was = new Set(before.resources.map((r) => r.arn));
    const is = new Set(readout.resources.map((r) => r.arn));
    const added = [...is].filter((a) => !was.has(a));
    const removed = [...was].filter((a) => !is.has(a));
    if (added.length || removed.length)
      audit({
        action: 'application.aws_resources_changed',
        entityType: 'application',
        entityId: c.application_id,
        actor,
        summary: `AWS resources tagged ${readout.tagKey}=${c.name}: ${[added.length ? `+${added.length}` : '', removed.length ? `−${removed.length}` : ''].filter(Boolean).join(' ')} (${readout.resources.length} now)`,
        details: { componentId, added: added.slice(0, 50), removed: removed.slice(0, 50) },
      });
  }
  return readout;
}

function toUser(u: Awaited<ReturnType<AwsClient['iamUsers']>>[number]): AwsIamUser & { tags: Record<string, string> } {
  return {
    userName: u.userName,
    arn: u.arn,
    createdAt: u.created,
    passwordLastUsed: u.passwordLastUsed,
    tags: u.tags,
    keys: u.keys.map((k) => ({ accessKeyId: k.accessKeyId, status: k.status, createdAt: k.created, lastUsedAt: k.lastUsed, lastService: k.lastService })),
  };
}

/** Every cloud-account component on an AWS platform whose readout is older than refreshHours (background job). */
export async function runAwsJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<{ id: string; updated_by: string; aws_state: string | null }>(
    `SELECT c.id, c.updated_by, c.aws_state FROM application_components c
     JOIN applications a ON a.id = c.application_id JOIN platforms p ON p.id = c.platform_id
     WHERE c.type = 'cloud-account' AND p.kind = ? AND a.archived = 0`,
    AWS_KIND,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<AwsReadout | null>(r.aws_state, null);
    if (last && now - Date.parse(last.readAt) < AWS_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshAwsComponent(r.id, r.updated_by, { now });
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading an AWS account failed');
    }
  }
  return n;
}

/** One part of a connector in the connection test: works, or what is missing (v0.3.1). */
export interface TestCheck {
  name: string;
  ok: boolean;
  message: string;
}

/** An AWS error in plain words: a missing IAM action names the action and who needs it. */
function partError(e: unknown, action: string, principal: string): string {
  const err = e as Error & { awsCode?: string; status?: number };
  const code = err.awsCode ?? '';
  if (/AccessDenied|UnauthorizedOperation|NotAuthorized|AuthorizationError/i.test(code) || /not authorized to perform/i.test(err.message))
    return `not allowed – the policy of ${principal || 'the principal'} lacks ${action} (docs/AWS.md)`;
  if (/cost explorer/i.test(err.message)) return `Cost Explorer is not enabled for the account – enable it in the Billing console (docs/AWS.md)`;
  return err.message.slice(0, 300);
}

/**
 * Connection test: STS says which account and principal the credentials (or the assumed role) are – GetCallerIdentity
 * needs no permission, so it alone said nothing about what Steward can read. Each part Steward uses is probed once
 * (tagging GetResources in the first region, Cost Explorer for one day, IAM ListUsers with one item). The test passes
 * when STS works; a missing part is a warning that names the IAM action.
 */
export async function testAws(platform: Platform, secrets: Record<string, string>): Promise<{ message: string; checks: TestCheck[] }> {
  const c = new AwsClient(platform, secrets);
  const role = platform.config.auth?.aws?.roleArn;
  let id: Awaited<ReturnType<AwsClient['callerIdentity']>>;
  try {
    id = await c.callerIdentity();
  } catch (e) {
    const m = (e as Error).message;
    if (role && /^AssumeRole/.test(m))
      throw new Error(
        `${m.slice(0, 300)} – the caller needs sts:AssumeRole on ${role}, and the role's trust policy must trust the caller (with the same external ID, if one is set; docs/AWS.md)`,
      );
    throw e;
  }
  const { regions, tagKey } = accountSettings(platform);
  const checks: TestCheck[] = [
    {
      name: role ? 'STS AssumeRole' : 'STS GetCallerIdentity',
      ok: true,
      message: role ? `${role} assumed, as ${id.arn}` : `account ${id.account} as ${id.arn}`,
    },
  ];
  const probe = async (name: string, action: string, ok: string, call: () => Promise<unknown>) => {
    try {
      await call();
      checks.push({ name, ok: true, message: ok });
    } catch (e) {
      checks.push({ name, ok: false, message: partError(e, action, id.arn) });
    }
  };
  const region = regions[0]!;
  await probe('Resources (tagging GetResources)', 'tag:GetResources', `readable in ${region}`, () =>
    c.json('tagging', region, 'ResourceGroupsTaggingAPI_20170126.GetResources', { TagFilters: [{ Key: tagKey }], ResourcesPerPage: 1 }),
  );
  const today = new Date();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  await probe('Costs (Cost Explorer GetCostAndUsage)', 'ce:GetCostAndUsage', 'readable (one request, $0.01)', () =>
    c.json('ce', CE_REGION, 'AWSInsightsIndexService.GetCostAndUsage', {
      TimePeriod: { Start: day(new Date(today.getTime() - 86400_000)), End: day(today) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );
  await probe('IAM users (IAM ListUsers)', 'iam:ListUsers (and iam:ListUserTags, iam:ListAccessKeys, iam:GetAccessKeyLastUsed)', 'readable', () =>
    c.query('iam', IAM_REGION, { Action: 'ListUsers', Version: '2010-05-08', MaxItems: '1' }),
  );
  const missing = checks.filter((x) => !x.ok);
  const base = `AWS account ${id.account} as ${id.arn} – regions ${regions.join(', ')}, resources linked by the tag "${tagKey}"`;
  return {
    message: missing.length ? `${base}. Not readable: ${missing.map((x) => x.name.replace(/ \(.*$/, '')).join(', ')} – see below.` : base,
    checks,
  };
}
