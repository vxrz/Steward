import type { Platform } from '@sm/shared';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { unescapeXml as unescape, xmlAll, xmlOne } from '../platforms/xml.js';

/**
 * The AWS APIs Steward reads from an AWS account (#116), signed with SigV4 per service – no AWS SDK. The platform's
 * base URL decides where the calls go: an AWS endpoint (https://sts.<region>.amazonaws.com) means the real
 * per-service endpoints; any other URL (LocalStack, the demo) receives every service, as AWS_ENDPOINT_URL does.
 *
 *   sts      GetCallerIdentity                    the connection test: which account and principal
 *   tagging  GetResources                         the inventory: resources with their tags, per region
 *   ce       GetCostAndUsage                      costs per month and service, per application tag
 *   iam      ListUsers, ListAccessKeys,           users and the age and last use of their access keys
 *            GetAccessKeyLastUsed
 */

export const IAM_REGION = 'us-east-1';
export const CE_REGION = 'us-east-1';

function realAws(p: Platform): boolean {
  try {
    return /\.amazonaws\.com(\.cn)?$/.test(new URL(p.baseUrl ?? '').hostname);
  } catch {
    return false;
  }
}

/** The endpoint of a service in a region (China: amazonaws.com.cn). */
export function endpointFor(p: Platform, service: string, region: string): string {
  if (!realAws(p)) return (p.baseUrl ?? '').replace(/\/+$/, '');
  const cn = region.startsWith('cn-');
  const dom = cn ? 'amazonaws.com.cn' : 'amazonaws.com';
  if (service === 'iam') return cn ? `https://iam.cn-north-1.${dom}` : `https://iam.${dom}`;
  if (service === 'ce') return cn ? `https://ce.cn-northwest-1.${dom}` : `https://ce.${CE_REGION}.${dom}`;
  return `https://${service}.${region}.${dom}`;
}

export function homeRegion(p: Platform): string {
  return p.config.auth?.aws?.region || 'us-east-1';
}

function awsError(what: string, r: HttpResult): Error {
  let b = r.body;
  if (typeof b === 'string' && b.trimStart().startsWith('{')) {
    try {
      b = JSON.parse(b);
    } catch {
      /* not JSON after all */
    }
  }
  let code: string | undefined;
  let message: string | undefined;
  if (typeof b === 'string') {
    code = xmlOne(b, 'Code');
    message = xmlOne(b, 'Message');
  } else if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    code =
      String(o.__type ?? o.code ?? '')
        .split('#')
        .pop() || undefined;
    message = typeof o.message === 'string' ? o.message : typeof o.Message === 'string' ? o.Message : undefined;
  }
  const err = new Error(`AWS ${what} failed with HTTP ${r.status}${code ? ` (${code}${message ? `: ${unescape(message)}` : ''})` : ''}`) as Error & {
    status: number;
    awsCode: string | undefined;
  };
  err.status = r.status;
  err.awsCode = code;
  return err;
}

export class AwsClient {
  constructor(
    readonly p: Platform,
    private readonly secrets: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  /** A JSON 1.1 API call (X-Amz-Target), e.g. tagging or Cost Explorer. */
  async json<T>(service: string, region: string, target: string, body: unknown): Promise<T> {
    const r = await platformRequest(
      this.p,
      this.secrets,
      {
        method: 'POST',
        url: `${endpointFor(this.p, service, region)}/`,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
        body: JSON.stringify(body),
        bodyType: 'text',
        aws: { service, region },
        maxResponseBytes: 16 * 1024 * 1024,
      },
      this.signal,
    );
    if (!r.ok) throw awsError(target.split('.').pop() ?? target, r);
    return (typeof r.body === 'string' ? JSON.parse(r.body || '{}') : r.body) as T;
  }

  /** A query API call (Action=…&Version=…), answered in XML: STS, IAM. */
  async query(service: string, region: string, params: Record<string, string>): Promise<string> {
    const r = await platformRequest(
      this.p,
      this.secrets,
      {
        method: 'POST',
        url: `${endpointFor(this.p, service, region)}/`,
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(params).toString(),
        bodyType: 'text',
        rawText: true,
        aws: { service, region },
        maxResponseBytes: 16 * 1024 * 1024,
      },
      this.signal,
    );
    if (!r.ok || typeof r.body !== 'string') throw awsError(params.Action ?? service, r);
    return r.body;
  }

  async callerIdentity(): Promise<{ account: string; arn: string; userId: string }> {
    const xml = await this.query('sts', homeRegion(this.p), { Action: 'GetCallerIdentity', Version: '2011-06-15' });
    return { account: xmlOne(xml, 'Account') ?? '', arn: unescape(xmlOne(xml, 'Arn') ?? ''), userId: xmlOne(xml, 'UserId') ?? '' };
  }

  /** Every resource of a region that carries the tag key (any value), with all its tags. */
  async taggedResources(region: string, tagKey: string, max = 5000): Promise<{ arn: string; tags: Record<string, string> }[]> {
    const out: { arn: string; tags: Record<string, string> }[] = [];
    let token: string | undefined;
    do {
      const r = await this.json<{ ResourceTagMappingList?: { ResourceARN: string; Tags?: { Key: string; Value: string }[] }[]; PaginationToken?: string }>(
        'tagging',
        region,
        'ResourceGroupsTaggingAPI_20170126.GetResources',
        { TagFilters: [{ Key: tagKey }], ResourcesPerPage: 100, ...(token ? { PaginationToken: token } : {}) },
      );
      for (const m of r.ResourceTagMappingList ?? []) out.push({ arn: m.ResourceARN, tags: Object.fromEntries((m.Tags ?? []).map((t) => [t.Key, t.Value])) });
      token = r.PaginationToken || undefined;
    } while (token && out.length < max);
    return out;
  }

  /**
   * Unblended costs per month (UTC months from `start` to the end of `end`'s month), grouped by the tag and by
   * service. Cost Explorer charges per request: the connector reads once a day.
   */
  async costs(o: { start: string; end: string; tagKey: string }): Promise<{
    byTag: { month: string; tag: string; amount: number; unit: string }[];
    byService: { month: string; service: string; amount: number; unit: string }[];
  }> {
    type Res = {
      ResultsByTime?: { TimePeriod: { Start: string }; Groups?: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }[] }[];
      NextPageToken?: string;
    };
    const read = async (groupBy: { Type: string; Key: string }) => {
      const rows: { month: string; key: string; amount: number; unit: string }[] = [];
      let token: string | undefined;
      do {
        const r = await this.json<Res>('ce', CE_REGION, 'AWSInsightsIndexService.GetCostAndUsage', {
          TimePeriod: { Start: o.start, End: o.end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [groupBy],
          ...(token ? { NextPageToken: token } : {}),
        });
        for (const t of r.ResultsByTime ?? [])
          for (const g of t.Groups ?? [])
            rows.push({
              month: t.TimePeriod.Start.slice(0, 7),
              key: g.Keys[0] ?? '',
              amount: Number(g.Metrics.UnblendedCost.Amount) || 0,
              unit: g.Metrics.UnblendedCost.Unit,
            });
        token = r.NextPageToken || undefined;
      } while (token);
      return rows;
    };
    const tag = await read({ Type: 'TAG', Key: o.tagKey });
    const service = await read({ Type: 'DIMENSION', Key: 'SERVICE' });
    return {
      // Cost Explorer names tag groups "<key>$<value>" ("<key>$" for untagged)
      byTag: tag.map((r) => ({ month: r.month, tag: r.key.includes('$') ? r.key.slice(r.key.indexOf('$') + 1) : r.key, amount: r.amount, unit: r.unit })),
      byService: service.map((r) => ({ month: r.month, service: r.key, amount: r.amount, unit: r.unit })),
    };
  }

  private async iamPaged(action: string, extra: Record<string, string>, member: string): Promise<string[]> {
    const items: string[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 100; page++) {
      const xml = await this.query('iam', IAM_REGION, { Action: action, Version: '2010-05-08', ...extra, ...(marker ? { Marker: marker } : {}) });
      items.push(...xmlAll(xml, member));
      marker = xmlOne(xml, 'IsTruncated') === 'true' ? unescape(xmlOne(xml, 'Marker') ?? '') || undefined : undefined;
      if (!marker) break;
    }
    return items;
  }

  /**
   * Who has what in IAM (access reviews, #118): every user with "group:NAME", "policy:NAME" (attached managed policies)
   * and "inline:NAME". A user that never signed in to the console but has access keys counts as technical.
   */
  async iamAccess(maxUsers = 2000): Promise<IamAccessSubject[]> {
    const users = (await this.iamPaged('ListUsers', {}, 'member')).slice(0, maxUsers);
    const out: IamAccessSubject[] = [];
    for (const u of users) {
      const userName = unescape(xmlOne(u, 'UserName') ?? '');
      if (!userName) continue;
      const groups = (await this.iamPaged('ListGroupsForUser', { UserName: userName }, 'member')).map((g) => `group:${unescape(xmlOne(g, 'GroupName') ?? '')}`);
      const attached = (await this.iamPaged('ListAttachedUserPolicies', { UserName: userName }, 'member')).map(
        (p) => `policy:${unescape(xmlOne(p, 'PolicyName') ?? '')}`,
      );
      const inline = (await this.iamPaged('ListUserPolicies', { UserName: userName }, 'member')).map((p) => `inline:${unescape(p.trim())}`);
      const keys = await this.iamPaged('ListAccessKeys', { UserName: userName }, 'member');
      const technical = !xmlOne(u, 'PasswordLastUsed') && keys.length > 0;
      out.push({ id: userName, name: userName, type: technical ? 'technical' : 'user', rights: [...groups, ...attached, ...inline].sort() });
    }
    return out;
  }

  /** IAM users with their access keys: id, status, created, last used. */
  async iamUsers(maxUsers = 1000): Promise<
    {
      userName: string;
      arn: string;
      created: string;
      passwordLastUsed: string | null;
      tags: Record<string, string>;
      keys: { accessKeyId: string; status: string; created: string; lastUsed: string | null; lastService: string | null }[];
    }[]
  > {
    const users = (await this.iamPaged('ListUsers', {}, 'member')).slice(0, maxUsers);
    const out = [];
    for (const u of users) {
      const userName = unescape(xmlOne(u, 'UserName') ?? '');
      if (!userName) continue;
      const keys = [];
      for (const k of await this.iamPaged('ListAccessKeys', { UserName: userName }, 'member')) {
        const accessKeyId = xmlOne(k, 'AccessKeyId') ?? '';
        if (!accessKeyId) continue;
        const last = await this.query('iam', IAM_REGION, { Action: 'GetAccessKeyLastUsed', Version: '2010-05-08', AccessKeyId: accessKeyId });
        const svc = xmlOne(last, 'ServiceName') ?? null;
        keys.push({
          accessKeyId,
          status: xmlOne(k, 'Status') ?? '',
          created: xmlOne(k, 'CreateDate') ?? '',
          lastUsed: xmlOne(last, 'LastUsedDate') ?? null,
          lastService: svc && svc !== 'N/A' ? svc : null,
        });
      }
      const tags = Object.fromEntries(
        (await this.iamPaged('ListUserTags', { UserName: userName }, 'member')).map((t) => [
          unescape(xmlOne(t, 'Key') ?? ''),
          unescape(xmlOne(t, 'Value') ?? ''),
        ]),
      );
      out.push({
        userName,
        arn: unescape(xmlOne(u, 'Arn') ?? ''),
        created: xmlOne(u, 'CreateDate') ?? '',
        passwordLastUsed: xmlOne(u, 'PasswordLastUsed') ?? null,
        tags,
        keys,
      });
    }
    return out;
  }
}

export interface IamAccessSubject {
  id: string;
  name: string;
  type: string;
  rights: string[];
}

/** The parts of an ARN: arn:partition:service:region:account:resource. */
export function parseArn(
  arn: string,
): { partition: string; service: string; region: string; account: string; resource: string; type: string; name: string } | null {
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return null;
  const resource = parts.slice(5).join(':');
  // resource is "type/name", "type:name" or just "name" (an S3 bucket)
  const cut = resource.search(/[/:]/);
  const type = cut > 0 ? resource.slice(0, cut) : parts[2] === 's3' ? 'bucket' : resource;
  const name = cut > 0 ? resource.slice(cut + 1) : resource;
  return { partition: parts[1]!, service: parts[2]!, region: parts[3]!, account: parts[4]!, resource, type, name };
}
