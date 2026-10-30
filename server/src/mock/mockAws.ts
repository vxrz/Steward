import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { signRequest } from '../platforms/sigv4.js';
import { escapeXml } from '../platforms/xml.js';

/**
 * A demo AWS account (#116) under /mock/aws-api – one endpoint for every service, like LocalStack: STS
 * GetCallerIdentity, the Resource Groups Tagging API, Cost Explorer and the IAM calls Steward reads. Every request
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
  keys: { id: string; status: string; created: string; lastUsed: string | null; service: string | null }[];
}

const USERS: DemoUser[] = [
  {
    name: 'ci-deploy',
    created: ago(900),
    passwordLastUsed: null,
    tags: { application: 'shop', team: 'web' },
    keys: [{ id: 'AKIADEMOCIDEPLOY0001', status: 'Active', created: ago(410), lastUsed: ago(1), service: 'ecs' }],
  },
  {
    name: 'backup-writer',
    created: ago(200),
    passwordLastUsed: null,
    tags: {},
    keys: [{ id: 'AKIADEMOBACKUPW00001', status: 'Active', created: ago(35), lastUsed: ago(0), service: 's3' }],
  },
  {
    name: 'old-intern',
    created: ago(1200),
    passwordLastUsed: ago(700),
    tags: { application: 'crm' },
    keys: [{ id: 'AKIADEMOOLDINTERN001', status: 'Inactive', created: ago(820), lastUsed: null, service: null }],
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

function scope(req: FastifyRequest): { service: string; region: string } | string {
  const auth = String(req.headers.authorization ?? '');
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/.exec(auth);
  if (!m) return 'missing or malformed SigV4 Authorization header';
  if (m[1] !== DEMO_AWS.accessKeyId) return 'The security token included in the request is invalid.';
  const stamp = String(req.headers['x-amz-date'] ?? '');
  const now = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
  if (Number.isNaN(now.getTime()) || Math.abs(Date.now() - now.getTime()) > 15 * 60_000) return 'Signature expired';
  const headers: Record<string, string> = {};
  for (const h of m[5]!.split(';')) if (h !== 'host' && h !== 'x-amz-date') headers[h] = String(req.headers[h] ?? '');
  const again = { method: req.method, url: `http://${req.headers.host}${req.url}`, headers, body: typeof req.body === 'string' ? req.body : '' };
  signRequest(again, { region: m[3]!, service: m[4]!, credentials: { accessKeyId: DEMO_AWS.accessKeyId, secretAccessKey: DEMO_AWS.secretAccessKey }, now });
  return again.headers.authorization === auth
    ? { service: m[4]!, region: m[3]! }
    : 'The request signature we calculated does not match the signature you provided.';
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
            `<ErrorResponse><Error><Code>InvalidAction</Code><Message>${escapeXml(String(p.Action ?? '?'))} for ${sc.service}</Message></Error></ErrorResponse>`,
          );
      });
    },
    { prefix: '/aws-api' },
  );
}
