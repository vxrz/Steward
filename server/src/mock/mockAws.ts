import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { signRequest } from '../platforms/sigv4.js';
import { escapeXml } from '../platforms/xml.js';

/**
 * A demo AWS account (#116) under /mock/aws-api – one endpoint for every service, like LocalStack: STS
 * GetCallerIdentity, the Resource Groups Tagging API, Cost Explorer, the IAM calls Steward reads, and for the
 * DynamoDB check (#233) Query, DescribeTable, DescribeContinuousBackups, DescribeTimeToLive and CloudWatch
 * GetMetricData of the example table crm-contacts. Every request
 * must be signed with SigV4 for the demo key AKIADEMOEXAMPLE / demoSecretKey; the mock recomputes the signature
 * (service and region from the credential scope) from the request as it arrived.
 */

export const DEMO_AWS = { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey', account: '123456789012', region: 'eu-central-1' };

const day = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString().replace(/\.\d{3}Z$/, 'Z');

const arn = (service: string, region: string, resource: string) => `arn:aws:${service}:${region}:${DEMO_AWS.account}:${resource}`;

/** Resources per region with their tags. */
const RESOURCES: Record<string, { arn: string; tags: Record<string, string> }[]> = {
  'eu-central-1': [
    { arn: arn('ec2', 'eu-central-1', 'instance/i-0a1b2c3d4e5f60001'), tags: { application: 'shop', environment: 'prod', Name: 'shop-web-1' } },
    { arn: arn('ec2', 'eu-central-1', 'instance/i-0a1b2c3d4e5f60002'), tags: { application: 'shop', environment: 'prod', Name: 'shop-web-2' } },
    { arn: arn('rds', 'eu-central-1', 'db:shop-orders'), tags: { application: 'shop', environment: 'prod' } },
    { arn: arn('elasticloadbalancing', 'eu-central-1', 'loadbalancer/app/shop-alb/50dc6c495c0c9188'), tags: { application: 'shop', environment: 'prod' } },
    { arn: `arn:aws:s3:::shop-assets-${DEMO_AWS.account}`, tags: { application: 'shop' } },
    { arn: arn('lambda', 'eu-central-1', 'function:crm-sync'), tags: { application: 'crm', environment: 'prod' } },
    { arn: arn('dynamodb', 'eu-central-1', 'table/crm-contacts'), tags: { application: 'crm', environment: 'prod' } },
  ],
  'eu-west-1': [
    { arn: arn('ec2', 'eu-west-1', 'instance/i-0f9e8d7c6b5a40003'), tags: { application: 'shop', environment: 'dr', Name: 'shop-dr' } },
    { arn: arn('ecs', 'eu-west-1', 'service/crm-cluster/crm-api'), tags: { application: 'crm', environment: 'prod' } },
  ],
};

interface DemoUser {
  name: string;
  created: string;
  passwordLastUsed: string | null;
  tags: Record<string, string>;
  groups?: string[];
  policies?: string[];
  inline?: string[];
  keys: { id: string; status: string; created: string; lastUsed: string | null; service: string | null }[];
}

const USERS: DemoUser[] = [
  {
    name: 'ci-deploy',
    created: ago(900),
    passwordLastUsed: null,
    tags: { application: 'shop', team: 'web' },
    groups: ['deployers'],
    policies: ['AmazonECS_FullAccess'],
    keys: [{ id: 'AKIADEMOCIDEPLOY001', status: 'Active', created: ago(410), lastUsed: ago(1), service: 'ecs' }],
  },
  {
    name: 'backup-writer',
    created: ago(200),
    passwordLastUsed: null,
    tags: {},
    policies: ['AmazonS3FullAccess'],
    inline: ['backup-bucket-only'],
    keys: [{ id: 'AKIADEMOBACKUPW0001', status: 'Active', created: ago(35), lastUsed: ago(0), service: 's3' }],
  },
  {
    name: 'old-intern',
    created: ago(1200),
    passwordLastUsed: ago(700),
    tags: { application: 'crm' },
    groups: ['developers', 'readonly'],
    keys: [{ id: 'AKIADEMOOLDINTERN01', status: 'Inactive', created: ago(820), lastUsed: null, service: null }],
  },
];

/** Monthly costs per application tag and per service for the last months (the current one so far). */
function costs(start: string, end: string, groupBy: { Type: string; Key: string }) {
  const months: string[] = [];
  const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 10) < end) {
    months.push(d.toISOString().slice(0, 10));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const base: Record<string, number> =
    groupBy.Type === 'TAG'
      ? { [`${groupBy.Key}$shop`]: 1840, [`${groupBy.Key}$crm`]: 410, [`${groupBy.Key}$`]: 95 }
      : {
          'Amazon Elastic Compute Cloud - Compute': 1120,
          'Amazon Relational Database Service': 610,
          'Amazon Simple Storage Service': 140,
          'AWS Lambda': 38,
          'Amazon DynamoDB': 62,
          'Elastic Load Balancing': 175,
          'Amazon Elastic Container Service': 200,
        };
  return {
    ResultsByTime: months.map((m, i) => ({
      TimePeriod: { Start: m, End: months[i + 1] ?? end },
      Groups: Object.entries(base).map(([k, v]) => ({
        Keys: [k],
        // a little growth each month, the current month only partly through
        Metrics: { UnblendedCost: { Amount: ((v * (1 + 0.03 * i)) / (i === months.length - 1 ? 2 : 1)).toFixed(4), Unit: 'USD' } },
      })),
    })),
  };
}

// ---------- DynamoDB and CloudWatch (#233) ----------

/**
 * The example table crm-contacts in eu-central-1: key contactId; the index by-segment-updated (segment, updatedAt
 * as ISO 8601) finds the newest contact per segment. Every item also carries syncedAt (epoch seconds).
 */
export const DEMO_DYNAMODB = {
  table: 'crm-contacts',
  region: 'eu-central-1',
  index: 'by-segment-updated',
  partitionKey: 'segment',
  timeAttribute: 'updatedAt',
  /** Seconds since the newest change per segment: partner is stale */
  segments: { customer: 140, lead: 45, partner: 26 * 3600 } as Record<string, number>,
};

const contacts = () =>
  Object.entries(DEMO_DYNAMODB.segments).flatMap(([segment, age], i) =>
    [0, 1].map((n) => {
      const at = Date.now() - (age + n * 600) * 1000;
      return {
        contactId: { S: `c-${1001 + i * 2 + n}` },
        segment: { S: segment },
        updatedAt: { S: new Date(at).toISOString() },
        syncedAt: { N: String(Math.floor(at / 1000)) },
        email: { S: `contact${i * 2 + n}@example.invalid` },
      };
    }),
  );

/** For tests: DynamoDB and CloudWatch actions answered with a throttling error, as AWS does under load. */
let throttled = new Map<string, string>();
export function setAwsThrottled(actions: Record<string, string>): void {
  throttled = new Map(Object.entries(actions));
}
/** For tests: the requests the DynamoDB and CloudWatch mock received (target and body). */
export const dynamoRequests: { target: string; service: string; region: string; signedHeaders: string; contentType: string; body: unknown }[] = [];

type Json = Record<string, unknown>;
const ddbError = (reply: FastifyReply, type: string, message: string, code = 400) =>
  reply
    .code(code)
    .type('application/x-amz-json-1.0')
    .send({ __type: `com.amazonaws.dynamodb.v20120810#${type}`, message });

/** A ProjectionExpression or key condition may only name attributes through #placeholders. */
function resolveName(token: string, names: Record<string, string> | undefined): string | null {
  const t = token.trim();
  if (!/^#[A-Za-z0-9_]+$/.test(t)) return null;
  return names?.[t] ?? null;
}

function dynamoDb(reply: FastifyReply, action: string, region: string, body: Json) {
  const table = body.TableName;
  if (action === 'Scan' || action === 'GetItem') return ddbError(reply, 'AccessDeniedException', `the demo policy does not allow dynamodb:${action}`);
  if (typeof table !== 'string' || table !== DEMO_DYNAMODB.table || region !== DEMO_DYNAMODB.region)
    return ddbError(reply, 'ResourceNotFoundException', 'Requested resource not found');
  const arn = `arn:aws:dynamodb:${region}:${DEMO_AWS.account}:table/${table}`;
  if (action === 'DescribeTable')
    return {
      Table: {
        TableName: table,
        TableArn: arn,
        TableStatus: 'ACTIVE',
        ItemCount: 48210,
        TableSizeBytes: 9_873_211,
        CreationDateTime: Math.floor(Date.now() / 1000) - 400 * 86400,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        KeySchema: [{ AttributeName: 'contactId', KeyType: 'HASH' }],
        AttributeDefinitions: [
          { AttributeName: 'contactId', AttributeType: 'S' },
          { AttributeName: 'segment', AttributeType: 'S' },
          { AttributeName: 'updatedAt', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: DEMO_DYNAMODB.index,
            IndexStatus: 'ACTIVE',
            KeySchema: [
              { AttributeName: 'segment', KeyType: 'HASH' },
              { AttributeName: 'updatedAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      },
    };
  if (action === 'DescribeContinuousBackups')
    return {
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: 'ENABLED',
        PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED', EarliestRestorableDateTime: Math.floor(Date.now() / 1000) - 35 * 86400 },
      },
    };
  if (action === 'DescribeTimeToLive') return { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } };
  if (action !== 'Query') return ddbError(reply, 'UnknownOperationException', `${action} is not answered by the demo`);
  // like DynamoDB: attribute names only through ExpressionAttributeNames, the value through ExpressionAttributeValues
  const names = body.ExpressionAttributeNames as Record<string, string> | undefined;
  const m = /^\s*(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)\s*$/.exec(String(body.KeyConditionExpression ?? ''));
  const keyName = m ? resolveName(m[1]!, names) : null;
  const keyValue = m ? (body.ExpressionAttributeValues as Record<string, Record<string, string>> | undefined)?.[m[2]!] : undefined;
  if (!keyName || !keyValue) return ddbError(reply, 'ValidationException', 'Invalid KeyConditionExpression');
  const projection =
    body.ProjectionExpression === undefined
      ? null
      : String(body.ProjectionExpression)
          .split(',')
          .map((x) => resolveName(x, names));
  if (projection?.some((x) => x === null))
    return ddbError(reply, 'ValidationException', 'Invalid ProjectionExpression: an attribute name is not a placeholder');
  const index = body.IndexName;
  if (index !== undefined && index !== DEMO_DYNAMODB.index)
    return ddbError(reply, 'ValidationException', 'The table does not have the specified index: ' + String(index));
  if (index ? keyName !== DEMO_DYNAMODB.partitionKey : keyName !== 'contactId')
    return ddbError(reply, 'ValidationException', 'Query condition missed key schema element');
  const items = contacts()
    .filter((it) => (it as Record<string, { S?: string }>)[keyName]?.S === keyValue.S)
    .sort((a, b) => (body.ScanIndexForward === false ? b.updatedAt.S.localeCompare(a.updatedAt.S) : a.updatedAt.S.localeCompare(b.updatedAt.S)))
    .slice(0, Math.max(1, Math.min(Number(body.Limit ?? 100), 100)))
    .map((it) => (projection ? Object.fromEntries(Object.entries(it).filter(([k]) => projection.includes(k))) : it));
  return { Count: items.length, ScannedCount: items.length, Items: items };
}

function getMetricData(body: Json) {
  const q = ((body.MetricDataQueries as Json[] | undefined) ?? [])[0] as
    | { Id?: string; MetricStat?: { Metric?: { Namespace?: string; MetricName?: string; Dimensions?: { Name: string; Value: string }[] }; Period?: number } }
    | undefined;
  const metric = q?.MetricStat?.Metric;
  const period = Number(q?.MetricStat?.Period ?? 60);
  const start = Number(body.StartTime);
  const end = Math.min(Number(body.EndTime), Math.floor(Date.now() / 1000));
  const ours =
    metric?.Namespace === 'AWS/DynamoDB' &&
    metric.MetricName === 'ConsumedWriteCapacityUnits' &&
    metric.Dimensions?.some((d) => d.Name === 'TableName' && d.Value === DEMO_DYNAMODB.table);
  const timestamps: number[] = [];
  const values: number[] = [];
  // CloudWatch is a few minutes behind: nothing for the newest three minutes; writes every minute before that
  if (ours && Number.isFinite(start) && Number.isFinite(end) && period >= 60)
    for (let t = Math.floor((end - 180) / period) * period; t >= start && timestamps.length < Number(body.MaxDatapoints ?? 100800); t -= period) {
      timestamps.push(t);
      values.push(((t / period) % 7) + 3);
    }
  if (body.ScanBy === 'TimestampAscending') {
    timestamps.reverse();
    values.reverse();
  }
  return {
    MetricDataResults: [{ Id: q?.Id ?? 'm', Label: metric?.MetricName ?? '', Timestamps: timestamps, Values: values, StatusCode: 'Complete' }],
    Messages: [],
  };
}

function scope(req: FastifyRequest): { service: string; region: string } | string {
  const auth = String(req.headers.authorization ?? '');
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/.exec(auth);
  if (!m) return 'missing or malformed SigV4 Authorization header';
  if (m[1] !== DEMO_AWS.accessKeyId) return 'The security token included in the request is invalid.';
  const stamp = String(req.headers['x-amz-date'] ?? '');
  const now = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
  if (Number.isNaN(now.getTime()) || Math.abs(Date.now() - now.getTime()) > 15 * 60_000) return 'Signature expired';
  const headers: Record<string, string> = Object.fromEntries(
    m[5]!
      .split(';')
      .filter((h) => h !== 'host' && h !== 'x-amz-date')
      .map((h) => [h, String(req.headers[h] ?? '')]),
  );
  const again = { method: req.method, url: `http://${req.headers.host}${req.url}`, headers, body: typeof req.body === 'string' ? req.body : '' };
  signRequest(again, { region: m[3]!, service: m[4]!, credentials: { accessKeyId: DEMO_AWS.accessKeyId, secretAccessKey: DEMO_AWS.secretAccessKey }, now });
  return again.headers.authorization === auth
    ? { service: m[4]!, region: m[3]! }
    : 'The request signature we calculated does not match the signature you provided.';
}

/** For tests: IAM actions the demo principal may not call (e.g. ce:GetCostAndUsage), answered like AWS answers them. */
let denied = new Set<string>();
export function setAwsDenied(actions: string[]): void {
  denied = new Set(actions);
}
const deniedMessage = (action: string) => `User: arn:aws:iam::${DEMO_AWS.account}:user/steward-reader is not authorized to perform: ${action} on resource: *`;

/** For tests: the IAM groups of a demo user (a right removed in AWS). */
export function setIamGroups(user: string, groups: string[]): void {
  const u = USERS.find((x) => x.name === user);
  if (u) u.groups = groups;
}

const xml = (reply: FastifyReply, action: string, result: string) =>
  reply
    .type('text/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><${action}Response><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>demo</RequestId></ResponseMetadata></${action}Response>`,
    );

export async function mockAws(app: FastifyInstance): Promise<void> {
  await app.register(
    async (aws) => {
      aws.removeAllContentTypeParsers();
      aws.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
      aws.post('/', async (req, reply) => {
        const sc = scope(req);
        if (typeof sc === 'string') return reply.code(403).type('application/json').send({ __type: 'UnrecognizedClientException', message: sc });
        const target = String(req.headers['x-amz-target'] ?? '');
        if (target.startsWith('DynamoDB_20120810.') || target.startsWith('GraniteServiceVersion20100801.')) {
          const contentType = String(req.headers['content-type'] ?? '');
          let body: Json;
          try {
            body = JSON.parse(String(req.body || '{}')) as Json;
          } catch {
            return reply.code(400).type('application/x-amz-json-1.0').send({ __type: 'SerializationException' });
          }
          const cloudWatch = target.startsWith('Granite');
          dynamoRequests.push({
            target,
            service: sc.service,
            region: sc.region,
            signedHeaders: /SignedHeaders=([^,]+)/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '',
            contentType,
            body,
          });
          if (dynamoRequests.length > 200) dynamoRequests.shift();
          // AWS JSON 1.0, signed for the service's own signing name
          if (contentType !== 'application/x-amz-json-1.0' || sc.service !== (cloudWatch ? 'monitoring' : 'dynamodb'))
            return reply
              .code(400)
              .type('application/x-amz-json-1.0')
              .send({ __type: 'UnknownOperationException', message: `${target} for ${sc.service}` });
          const action = target.slice(target.indexOf('.') + 1);
          const iamAction = `${cloudWatch ? 'cloudwatch' : 'dynamodb'}:${action}`;
          if (denied.has(iamAction))
            return reply
              .code(400)
              .type('application/x-amz-json-1.0')
              .send({ __type: 'AccessDeniedException', message: deniedMessage(iamAction) });
          const throttle = throttled.get(iamAction);
          if (throttle)
            return reply.code(400).type('application/x-amz-json-1.0').send({ __type: throttle, message: 'Rate of requests exceeds the allowed throughput.' });
          reply.type('application/x-amz-json-1.0');
          if (cloudWatch) return action === 'GetMetricData' ? getMetricData(body) : reply.code(400).send({ __type: 'InvalidAction', message: action });
          return dynamoDb(reply, action, sc.region, body);
        }
        if (target) {
          let body: {
            TagFilters?: { Key?: string }[];
            PaginationToken?: string;
            TimePeriod: { Start: string; End: string };
            GroupBy: { Type: string; Key: string }[];
          };
          try {
            body = JSON.parse(String(req.body || '{}')) as typeof body;
          } catch {
            return reply.code(400).send({ __type: 'SerializationException' });
          }
          reply.type('application/x-amz-json-1.1');
          const action = target.endsWith('.GetResources') ? 'tag:GetResources' : target.endsWith('.GetCostAndUsage') ? 'ce:GetCostAndUsage' : '';
          if (denied.has(action)) return reply.code(400).send({ __type: 'AccessDeniedException', Message: deniedMessage(action) });
          if (target === 'ResourceGroupsTaggingAPI_20170126.GetResources' && sc.service === 'tagging') {
            const key = body.TagFilters?.[0]?.Key as string | undefined;
            const all = (RESOURCES[sc.region] ?? []).filter((r) => !key || key in r.tags);
            // two per page, to exercise the paging
            const from = Number(body.PaginationToken || 0);
            const page = all.slice(from, from + 2);
            return {
              ResourceTagMappingList: page.map((r) => ({ ResourceARN: r.arn, Tags: Object.entries(r.tags).map(([Key, Value]) => ({ Key, Value })) })),
              PaginationToken: from + 2 < all.length ? String(from + 2) : '',
            };
          }
          if (target === 'AWSInsightsIndexService.GetCostAndUsage' && sc.service === 'ce' && sc.region === 'us-east-1') {
            return costs(body.TimePeriod.Start, body.TimePeriod.End, body.GroupBy[0]);
          }
          return reply.code(400).send({ __type: 'UnknownOperationException', message: `${target} for ${sc.service}` });
        }
        const p = Object.fromEntries(new URLSearchParams(String(req.body ?? '')));
        if (denied.has(`${sc.service}:${p.Action}`))
          return reply
            .code(403)
            .type('text/xml')
            .send(
              // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- XML of a dev/demo-only mock, the value is XML-escaped; not HTML
              `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>${escapeXml(deniedMessage(`${sc.service}:${p.Action}`))}</Message></Error></ErrorResponse>`,
            );
        if (p.Action === 'GetCallerIdentity' && sc.service === 'sts')
          return xml(
            reply,
            'GetCallerIdentity',
            `<Arn>arn:aws:iam::${DEMO_AWS.account}:user/steward-reader</Arn><UserId>AIDADEMOSTEWARD</UserId><Account>${DEMO_AWS.account}</Account>`,
          );
        if (sc.service === 'iam' && sc.region === 'us-east-1') {
          if (p.Action === 'ListUsers') {
            // two per page, to exercise the paging
            const from = Number(p.Marker || 0);
            const page = USERS.slice(from, from + 2);
            const more = from + 2 < USERS.length;
            return xml(
              reply,
              'ListUsers',
              `<Users>${page
                .map(
                  (u) =>
                    `<member><UserName>${escapeXml(u.name)}</UserName><Arn>arn:aws:iam::${DEMO_AWS.account}:user/${escapeXml(u.name)}</Arn><CreateDate>${u.created}</CreateDate>${u.passwordLastUsed ? `<PasswordLastUsed>${u.passwordLastUsed}</PasswordLastUsed>` : ''}</member>`,
                )
                // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- XML of a dev/demo-only mock, every request value XML-escaped (numbers and fixed demo values aside); not HTML
                .join('')}</Users><IsTruncated>${more}</IsTruncated>${more ? `<Marker>${from + 2}</Marker>` : ''}`,
            );
          }
          if (p.Action === 'ListAccessKeys') {
            const u = USERS.find((x) => x.name === p.UserName);
            if (!u)
              return reply
                .code(404)
                .type('text/xml')
                .send('<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>no such user</Message></Error></ErrorResponse>');
            return xml(
              reply,
              'ListAccessKeys',
              `<AccessKeyMetadata>${u.keys.map((k) => `<member><UserName>${u.name}</UserName><AccessKeyId>${k.id}</AccessKeyId><Status>${k.status}</Status><CreateDate>${k.created}</CreateDate></member>`).join('')}</AccessKeyMetadata><IsTruncated>false</IsTruncated>`,
            );
          }
          if (p.Action === 'ListUserTags') {
            const u = USERS.find((x) => x.name === p.UserName);
            return xml(
              reply,
              'ListUserTags',
              `<Tags>${Object.entries(u?.tags ?? {})
                .map(([k, v]) => `<member><Key>${escapeXml(k)}</Key><Value>${escapeXml(v)}</Value></member>`)
                .join('')}</Tags><IsTruncated>false</IsTruncated>`,
            );
          }
          if (p.Action === 'ListGroupsForUser' || p.Action === 'ListAttachedUserPolicies' || p.Action === 'ListUserPolicies') {
            const u = USERS.find((x) => x.name === p.UserName);
            if (!u)
              return reply
                .code(404)
                .type('text/xml')
                .send('<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>no such user</Message></Error></ErrorResponse>');
            const body =
              p.Action === 'ListGroupsForUser'
                ? `<Groups>${(u.groups ?? []).map((g) => `<member><GroupName>${escapeXml(g)}</GroupName></member>`).join('')}</Groups>`
                : p.Action === 'ListAttachedUserPolicies'
                  ? `<AttachedPolicies>${(u.policies ?? []).map((x) => `<member><PolicyName>${escapeXml(x)}</PolicyName></member>`).join('')}</AttachedPolicies>`
                  : `<PolicyNames>${(u.inline ?? []).map((x) => `<member>${escapeXml(x)}</member>`).join('')}</PolicyNames>`;
            return xml(reply, p.Action, `${body}<IsTruncated>false</IsTruncated>`);
          }
          if (p.Action === 'GetAccessKeyLastUsed') {
            const k = USERS.flatMap((u) => u.keys).find((x) => x.id === p.AccessKeyId);
            return xml(
              reply,
              'GetAccessKeyLastUsed',
              `<AccessKeyLastUsed>${k?.lastUsed ? `<LastUsedDate>${k.lastUsed}</LastUsedDate><ServiceName>${k.service}</ServiceName><Region>eu-central-1</Region>` : '<ServiceName>N/A</ServiceName><Region>N/A</Region>'}</AccessKeyLastUsed>`,
            );
          }
        }
        return reply
          .code(400)
          .type('text/xml')
          .send(
            // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- XML of a dev/demo-only mock, every request value XML-escaped (numbers and fixed demo values aside); not HTML
            `<ErrorResponse><Error><Code>InvalidAction</Code><Message>${escapeXml(String(p.Action ?? '?'))} for ${escapeXml(sc.service)}</Message></Error></ErrorResponse>`,
          );
      });
    },
    { prefix: '/aws-api' },
  );
}
