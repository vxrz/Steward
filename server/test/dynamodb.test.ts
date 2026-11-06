import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSchema, definitionIssues, monitorDefinitionSchema, type CheckOf } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The DynamoDB monitor check (#233): the requests it builds (placeholders for every attribute name, Limit 1, newest
 * first, AWS JSON 1.0 signed for dynamodb and monitoring), how it reads the time of an item, its status logic and
 * throttling, end to end against the demo account's table crm-contacts, and the method/headers/body of the platform
 * freshness check.
 */

process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

// the server first: the modules under test read its configuration when they are imported
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

const ddb = (extra: Record<string, unknown> = {}): CheckOf<'dynamodb'> =>
  checkSchema.parse({
    id: 'ddb',
    name: 'Contacts fresh',
    type: 'dynamodb',
    platform: 'AWS (demo)',
    region: 'eu-central-1',
    table: 'crm-contacts',
    indexName: 'by-segment-updated',
    partitionKey: 'segment',
    partitionValues: ['customer'],
    timeAttribute: 'updatedAt',
    freshnessMode: 'maxAge',
    maxAgeSeconds: 3600,
    ...extra,
  }) as CheckOf<'dynamodb'>;

const issuesOf = (check: Record<string, unknown>) =>
  definitionIssues(monitorDefinitionSchema.parse({ name: 'x', checks: [{ id: 'c', name: 'c', type: 'dynamodb', platform: 'p', table: 'tbl', ...check }] })).map(
    (i) => `${i.path.split('.').pop()}: ${i.message}`,
  );

describe('requests', () => {
  it('a Query for the newest item: Limit 1, newest first, only the key and the time attribute, every name a placeholder', async () => {
    const { newestItemQuery } = await import('../src/aws/dynamodb.js');
    expect(newestItemQuery(ddb(), 'customer')).toEqual({
      TableName: 'crm-contacts',
      IndexName: 'by-segment-updated',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'segment', '#t': 'updatedAt' },
      ExpressionAttributeValues: { ':pk': { S: 'customer' } },
      ProjectionExpression: '#pk, #t',
      Limit: 1,
      ScanIndexForward: false,
      ReturnConsumedCapacity: 'NONE',
    });
    // names and values that look like expressions stay data: the expressions never change
    const evil = newestItemQuery(ddb({ indexName: '', partitionKey: 'a = :x OR #b', timeAttribute: 'ts, secret', partitionKeyType: 'N' }), '42');
    expect(evil).not.toHaveProperty('IndexName');
    expect(evil).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ProjectionExpression: '#pk, #t',
      ExpressionAttributeNames: { '#pk': 'a = :x OR #b', '#t': 'ts, secret' },
      ExpressionAttributeValues: { ':pk': { N: '42' } },
    });
  });

  it('GetMetricData of ConsumedWriteCapacityUnits: the window and a half, coarser periods for long windows', async () => {
    const { writeActivityRequest } = await import('../src/aws/dynamodb.js');
    const now = Date.UTC(2026, 10, 6, 12, 0, 30);
    const r = writeActivityRequest(ddb({ mode: 'writeActivity', freshnessMode: 'maxAge', maxAgeSeconds: 1800 }), now);
    expect(r).toMatchObject({ periodSeconds: 60, lookbackSeconds: 2700 });
    expect(r.body).toEqual({
      MetricDataQueries: [
        {
          Id: 'writes',
          MetricStat: {
            Metric: { Namespace: 'AWS/DynamoDB', MetricName: 'ConsumedWriteCapacityUnits', Dimensions: [{ Name: 'TableName', Value: 'crm-contacts' }] },
            Period: 60,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
      ],
      StartTime: Date.UTC(2026, 10, 6, 12, 1) / 1000 - 2700,
      EndTime: Date.UTC(2026, 10, 6, 12, 1) / 1000,
      ScanBy: 'TimestampDescending',
      MaxDatapoints: 1500,
    });
    // cadence: expected every 6 h, down after 4 missed → 36 h back, 300 s periods (432 points)
    expect(writeActivityRequest(ddb({ mode: 'writeActivity', freshnessMode: 'cadence', expectedIntervalSeconds: 21600 }), now)).toMatchObject({
      periodSeconds: 300,
      lookbackSeconds: 129600,
    });
    // a year: hourly data at most 455 days back, in 6 h periods
    expect(writeActivityRequest(ddb({ mode: 'writeActivity', maxAgeSeconds: 365 * 86400 }), now)).toMatchObject({ periodSeconds: 86400 });
  });
});

describe('time of an item', () => {
  it('reads ISO 8601 (with zone, offset, without zone as UTC, a sort key suffix), epoch seconds and milliseconds', async () => {
    const { attributeTime } = await import('../src/aws/dynamodb.js');
    const t = Date.UTC(2026, 10, 6, 10, 15, 0);
    expect(attributeTime({ S: '2026-11-06T10:15:00Z' }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ S: '2026-11-06T11:15:00+01:00' }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ S: '2026-11-06T11:15:00+0100' }, 'iso8601')).toEqual({ ms: t });
    expect(attributeTime({ S: '2026-11-06T10:15:00' }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ S: '2026-11-06T10:15:00.123456Z' }, 'auto')).toEqual({ ms: t + 123 });
    expect(attributeTime({ S: '2026-11-06T10:15:00Z#order-77' }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ S: '2026-11-06' }, 'auto')).toEqual({ ms: Date.UTC(2026, 10, 6) });
    expect(attributeTime({ N: String(t / 1000) }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ N: String(t) }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ N: '1762424100.5' }, 'auto')).toEqual({ ms: 1762424100500 });
    expect(attributeTime({ S: String(t / 1000) }, 'auto')).toEqual({ ms: t });
    expect(attributeTime({ N: String(t / 1000) }, 'epochSeconds')).toEqual({ ms: t });
    expect(attributeTime({ N: String(t) }, 'epochMillis')).toEqual({ ms: t });
    // a configured format is kept to
    expect(attributeTime({ N: String(t / 1000) }, 'epochMillis')).toEqual({ ms: t / 1000 });
    expect(attributeTime({ N: '-5' }, 'auto')).toEqual({ error: 'is not a time between 1970 and 9999' });
    expect(attributeTime({ N: String(t) }, 'iso8601')).toEqual({ error: 'is a number, not an ISO 8601 date' });
    expect(attributeTime({ S: '2026-11-06T10:15:00Z' }, 'epochSeconds')).toEqual({ error: 'is not a number (epoch seconds)' });
    expect(attributeTime({ S: 'yesterday' }, 'auto')).toEqual({ error: 'is neither an ISO 8601 date nor a number' });
    expect(attributeTime({ BOOL: true }, 'auto')).toEqual({ error: 'is neither a string nor a number' });
    expect(attributeTime({ S: '20261106' }, 'iso8601')).toEqual({ error: 'is not an ISO 8601 date' });
  });
});

describe('errors', () => {
  it('throttling is unknown with the reason, never down; a missing table is down; a denied call names the action', async () => {
    const { classifyAwsError } = await import('../src/aws/dynamodb.js');
    const err = (awsCode: string, status = 400) => Object.assign(new Error(`AWS Query failed with HTTP ${status} (${awsCode}: …)`), { awsCode, status });
    for (const code of ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'Throttling'])
      expect(classifyAwsError(err(code), 'Query', ddb(), 'eu-central-1')).toMatchObject({
        status: 'unknown',
        throttled: true,
        message: `Query was throttled by AWS (${code}) – read again on the next run`,
      });
    expect(classifyAwsError(err('ResourceNotFoundException'), 'Query', ddb(), 'eu-west-1')).toMatchObject({
      status: 'down',
      message: 'table crm-contacts (index by-segment-updated) not found in eu-west-1',
    });
    expect(classifyAwsError(err('AccessDeniedException'), 'Query', ddb(), 'eu-central-1').message).toMatch(
      /the policy needs dynamodb:Query on the table and its \/index\/\*$/,
    );
    expect(classifyAwsError(err('AccessDeniedException'), 'GetMetricData', ddb(), 'eu-central-1')).toMatchObject({ status: 'unknown' });
    expect(classifyAwsError(err('AccessDeniedException'), 'GetMetricData', ddb(), 'eu-central-1').message).toMatch(/needs cloudwatch:GetMetricData$/);
  });
});

describe('validation', () => {
  it('names the fields a mode needs, and checks names, regions and key values', () => {
    expect(issuesOf({ mode: 'newestItem', expectedIntervalSeconds: 60 })).toEqual([
      'partitionKey: newest item needs the partition key attribute',
      'partitionValues: newest item needs at least one partition key value',
      'timeAttribute: newest item needs the time attribute',
    ]);
    expect(issuesOf({ partitionKey: 'pk', partitionKeyType: 'N', partitionValues: ['7', 'seven'], timeAttribute: 'pk', freshnessMode: 'maxAge' })).toEqual([
      'partitionValues: the partition key is a number: every value must be one',
      'timeAttribute: the time attribute cannot be the partition key',
      'maxAgeSeconds: maxAge mode needs the maximum age',
    ]);
    // region and index name are rules of the schema – also for Check now, which parses only the check: the region is
    // part of the endpoint's host name
    const bad = checkSchema.safeParse({ id: 'c', name: 'c', type: 'dynamodb', platform: 'p', table: 'tbl', region: 'x@elsewhere.invalid#', indexName: 'x' });
    expect(bad.success ? [] : bad.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'region: an AWS region, e.g. eu-central-1',
      'indexName: an index name: 3–255 of a-z, A-Z, 0-9, _ - .',
    ]);
    expect(issuesOf({ partitionKey: 'pk', partitionValues: ['a', 'a'], timeAttribute: 't', expectedIntervalSeconds: 60 })).toEqual([
      'partitionValues: each partition key value only once',
    ]);
    // write activity needs the freshness limits only; hygiene nothing more
    expect(issuesOf({ mode: 'writeActivity' })).toEqual(['expectedIntervalSeconds: cadence mode needs the expected interval']);
    expect(issuesOf({ mode: 'hygiene' })).toEqual([]);
    expect(checkSchema.safeParse({ id: 'c', name: 'c', type: 'dynamodb', platform: 'p', table: 'no spaces' }).success).toBe(false);
    expect(checkSchema.safeParse({ id: 'c', name: 'c', type: 'dynamodb', platform: 'p', table: 't', partitionValues: Array(21).fill('a') }).success).toBe(
      false,
    );
  });
});

describe('against the demo account', () => {
  let aws: string;
  let mock: typeof import('../src/mock/mockAws.js');

  beforeAll(async () => {
    await s.api('POST', '/demo/setup', {});
    aws = (await s.api('GET', '/platforms')).find((p: { name: string }) => p.name === 'AWS (demo)').id;
    mock = await import('../src/mock/mockAws.js');
  });
  afterAll(async () => {
    mock?.setAwsThrottled({});
    mock?.setAwsDenied([]);
  });

  const preview = (check: Record<string, unknown>) =>
    s.api('POST', '/monitors/check-preview', {
      check: {
        id: 'ddb',
        name: 'Contacts fresh',
        type: 'dynamodb',
        platform: aws,
        region: 'eu-central-1',
        table: 'crm-contacts',
        indexName: 'by-segment-updated',
        partitionKey: 'segment',
        partitionValues: ['customer', 'lead'],
        timeAttribute: 'updatedAt',
        freshnessMode: 'maxAge',
        maxAgeSeconds: 3600,
        ...check,
      },
    });

  it('newest item: one signed Query per partition key value, each with its own age', async () => {
    mock.dynamoRequests.length = 0;
    const r = await preview({});
    expect(r).toMatchObject({ status: 'up', message: expect.stringMatching(/^DynamoDB crm-contacts: All 2 partition keys are fresh \(oldest 2 min\)$/) });
    expect(mock.dynamoRequests).toHaveLength(2);
    for (const q of mock.dynamoRequests) {
      expect(q).toMatchObject({
        target: 'DynamoDB_20120810.Query',
        service: 'dynamodb',
        region: 'eu-central-1',
        contentType: 'application/x-amz-json-1.0',
        signedHeaders: 'content-type;host;x-amz-date;x-amz-target',
      });
      expect(q.body).toMatchObject({ Limit: 1, ScanIndexForward: false, ProjectionExpression: '#pk, #t', KeyConditionExpression: '#pk = :pk' });
    }
    expect(mock.dynamoRequests.map((q) => (q.body as any).ExpressionAttributeValues[':pk'].S)).toEqual(['customer', 'lead']);
    // a stale key: its own message; the others are named only when they fail too
    const stale = await preview({ partitionValues: ['customer', 'partner'], degradedAgeSeconds: 600 });
    expect(stale).toMatchObject({ status: 'down', message: 'DynamoDB crm-contacts: Newest item of partner is 26.0 h old (maximum 60 min)' });
    // epoch seconds from another attribute; one value
    expect(await preview({ partitionValues: ['lead'], timeAttribute: 'syncedAt', timeFormat: 'epochSeconds' })).toMatchObject({
      status: 'up',
      message: expect.stringMatching(/^DynamoDB crm-contacts: Newest item of lead is 4\d s old$/),
    });
    // a key value without items, an attribute the items lack
    expect(await preview({ partitionValues: ['nobody'] })).toMatchObject({ status: 'down', message: 'DynamoDB crm-contacts: no item with segment = nobody' });
    expect(await preview({ partitionValues: ['lead'], timeAttribute: 'deletedAt' })).toMatchObject({
      status: 'unknown',
      message: 'DynamoDB crm-contacts: the newest item of lead has no attribute deletedAt',
    });
    // the table's own key (no index): the contact's updatedAt
    expect(await preview({ indexName: '', partitionKey: 'contactId', partitionValues: ['c-1003'] })).toMatchObject({ status: 'up' });
  });

  it('a missing table or index is down; throttling is unknown with the reason, never down; secrets are not in messages', async () => {
    expect(await preview({ table: 'crm-nothing' })).toMatchObject({
      status: 'down',
      message: 'DynamoDB crm-nothing: table crm-nothing (index by-segment-updated) not found in eu-central-1',
    });
    expect((await preview({ region: 'eu-west-1' })).status).toBe('down');
    // a region that would change the endpoint's host is refused before any call
    await expect(preview({ region: 'x@elsewhere.invalid#' })).rejects.toThrow(/→ 400.*an AWS region/);
    mock.setAwsThrottled({ 'dynamodb:Query': 'ProvisionedThroughputExceededException' });
    try {
      const r = await preview({ partitionValues: ['customer', 'lead', 'partner'] });
      expect(r).toMatchObject({
        status: 'unknown',
        message: 'DynamoDB crm-contacts: Query was throttled by AWS (ProvisionedThroughputExceededException) – read again on the next run',
      });
      expect(r.message).not.toContain('demoSecretKey');
    } finally {
      mock.setAwsThrottled({});
    }
    mock.setAwsDenied(['dynamodb:Query']);
    try {
      expect(await preview({})).toMatchObject({
        status: 'unknown',
        message: expect.stringMatching(/not authorized to perform: dynamodb:Query.* – the policy needs dynamodb:Query on the table and its \/index\/\*$/),
      });
    } finally {
      mock.setAwsDenied([]);
    }
  });

  it('write activity: CloudWatch GetMetricData signed for monitoring, the newest minute with writes is the age', async () => {
    mock.dynamoRequests.length = 0;
    const r = await preview({ mode: 'writeActivity', maxAgeSeconds: 1800 });
    expect(r).toMatchObject({
      status: 'up',
      message: expect.stringMatching(
        /^DynamoDB crm-contacts: Newest write is \d+ (s|min) old \([\d.]+ write capacity units in the last 45 min, by 60 s periods\)$/,
      ),
    });
    expect(mock.dynamoRequests).toEqual([
      expect.objectContaining({ target: 'GraniteServiceVersion20100801.GetMetricData', service: 'monitoring', contentType: 'application/x-amz-json-1.0' }),
    ]);
    // a table without writes in the window
    expect(await preview({ mode: 'writeActivity', table: 'crm-archive' })).toMatchObject({
      status: 'down',
      message: 'DynamoDB crm-archive: no writes within the last 90 min (CloudWatch ConsumedWriteCapacityUnits)',
    });
    mock.setAwsThrottled({ 'cloudwatch:GetMetricData': 'Throttling' });
    try {
      expect(await preview({ mode: 'writeActivity' })).toMatchObject({ status: 'unknown', message: expect.stringContaining('throttled by AWS (Throttling)') });
    } finally {
      mock.setAwsThrottled({});
    }
  });

  it('hygiene: ACTIVE, point-in-time recovery and time to live – required or only reported', async () => {
    mock.dynamoRequests.length = 0;
    expect(await preview({ mode: 'hygiene', pointInTimeRecovery: 'required' })).toMatchObject({
      status: 'up',
      message: 'DynamoDB crm-contacts: ACTIVE, 48,210 items, 9.9 MB, point-in-time recovery on, time to live disabled (reported only)',
    });
    expect(mock.dynamoRequests.map((q) => q.target)).toEqual([
      'DynamoDB_20120810.DescribeTable',
      'DynamoDB_20120810.DescribeContinuousBackups',
      'DynamoDB_20120810.DescribeTimeToLive',
    ]);
    expect(await preview({ mode: 'hygiene', timeToLive: 'required' })).toMatchObject({
      status: 'degraded',
      message: 'DynamoDB crm-contacts: time to live disabled, ACTIVE, 48,210 items, 9.9 MB, point-in-time recovery on',
    });
    expect((await preview({ mode: 'hygiene', timeToLive: 'required', failAs: 'down' })).status).toBe('down');
    // a part that may not be read: unknown when required, a note otherwise
    mock.setAwsDenied(['dynamodb:DescribeContinuousBackups']);
    try {
      expect((await preview({ mode: 'hygiene', pointInTimeRecovery: 'required' })).status).toBe('unknown');
      const r = await preview({ mode: 'hygiene' });
      expect(r.status).toBe('up');
      expect(r.message).toContain('point-in-time recovery not readable');
    } finally {
      mock.setAwsDenied([]);
    }
  });

  it('refuses a platform that is not an AWS account', async () => {
    const other = (await s.api('GET', '/platforms')).find((p: { kind: string }) => p.kind === 'snowflake').id;
    expect(await preview({ platform: other })).toMatchObject({ status: 'unknown', message: expect.stringMatching(/is not an AWS platform$/) });
  });

  it('the example monitor runs all three modes, and its ages, item count and size become dataset metrics', async () => {
    const m = (await s.api('GET', '/monitors')).find((x: { key: string }) => x.key === 'crm-contacts-dynamodb');
    expect(m).toBeTruthy();
    const def = (await s.api('GET', `/monitors/${m.id}`)).definition;
    expect(def.checks.map((c: { mode: string; platform: string }) => [c.mode, c.platform])).toEqual([
      ['newestItem', aws],
      ['writeActivity', aws],
      ['hygiene', aws],
    ]);
    const eng = await import('../src/monitors/engine.js');
    eng.loadAll();
    const run = await s.api('POST', `/monitors/${m.id}/run`, {});
    expect(run.checks.map((c: { checkId: string; last: { status: string } }) => [c.checkId, c.last?.status])).toEqual([
      ['newest-contact', 'up'],
      ['writes', 'up'],
      ['hygiene', 'up'],
    ]);
    const results = await s.api('GET', `/monitors/${m.id}/checks/newest-contact/results`);
    expect(results[0].value).toMatchObject({ keys: [{ key: 'customer' }, { key: 'lead' }] });
    const { publishDirtyDatasets } = await import('../src/monitors/datasets.js');
    publishDirtyDatasets();
    const ds = await s.api('GET', '/datasets/monitor.crm-contacts-dynamodb');
    expect(ds.metrics).toMatchObject({
      'newest-contact.ageSeconds': expect.any(Number),
      'newest-contact.ageSeconds.customer': expect.any(Number),
      'newest-contact.ageSeconds.lead': expect.any(Number),
      'writes.writes': expect.any(Number),
      'hygiene.itemCount': 48210,
      'hygiene.tableSizeBytes': 9873211,
      checks: 3,
    });
  });

  it('platform freshness with POST: the method, headers and body are sent', async () => {
    const r = await s.api('POST', '/monitors/check-preview', {
      check: {
        id: 'f',
        name: 'Newest via POST',
        type: 'freshness',
        source: 'platform',
        platform: aws,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.DescribeTable' },
        body: { TableName: 'crm-contacts' },
        // the base URL is signed for sts: the mock refuses it for DynamoDB – the request arrived as POST with the body
        timestamp: 'Table.CreationDateTime',
        mode: 'maxAge',
        maxAgeSeconds: 60,
      },
    });
    expect(r).toMatchObject({ status: 'unknown', message: expect.stringContaining('HTTP 400') });
    const last = mock.dynamoRequests.at(-1)!;
    expect(last).toMatchObject({ target: 'DynamoDB_20120810.DescribeTable', service: 'sts', body: { TableName: 'crm-contacts' } });
  });
});
