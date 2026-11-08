import { HTTP_RESPONSE_MB, isMutating, type NodeOf } from '@sm/shared';
import { audit } from '../../audit.js';
import { buildUrl, platformRequest, secretValues, type HttpResult } from '../../platforms/http.js';
import { findRecording, missingRecording } from '../../platforms/recordings.js';
import { assertKindRules } from '../../platforms/restrictedOrigins.js';
import { stringify } from '../expr.js';
import * as store from '../store.js';
import { connectionSources, type Binding, type LeafResult, type StepContext, type StepExecutor } from './context.js';
import { enforceOutbound, scanSecrets, secretBindings } from './outbound.js';

/**
 * "Call an API": one request (or a paginated read) on the bound platform. Writes are skipped and audited in dry runs;
 * test runs answer from recordings; every request passes the outbound policy and the egress scan first.
 */
export const httpStep: StepExecutor<'http'> = {
  type: 'http',
  exec: execHttp,
  async preview(node, ctx) {
    const b = ctx.bindings[node.connection];
    return {
      method: node.method,
      url: joinUrl(b?.baseUrl ?? '', await ctx.str(node.path)),
      query: await ctx.render(node.query ?? {}), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
      headers: await ctx.render(node.headers ?? {}), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
      ...(node.body !== undefined ? { body: await ctx.render(node.body) } : {}), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
      write: isMutating(node),
    };
  },
  sources: (step, ctx) => connectionSources(step.connection, ctx),
};

async function execHttp(step: NodeOf<'http'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  // AWS (v0.3.1): another AWS service of the account, signed with the platform – the path is relative to its endpoint
  const awsScope = step.aws;
  let awsOrigin: string | undefined;
  let awsEndpoint = '';
  if (awsScope) {
    if (b.platform.config.auth?.type !== 'aws_sigv4')
      throw new Error(`"aws" needs a platform with AWS request signing (SigV4); "${b.platform.name}" uses ${b.platform.config.auth?.type ?? 'none'}`);
    if (b.platform.kind === 'aws') {
      const { endpointFor } = await import('../../aws/client.js');
      awsEndpoint = endpointFor(b.platform, awsScope.service, awsScope.region);
      if (/^https:\/\/[^/]+\.amazonaws\.com(\.cn)?$/i.test(awsEndpoint)) awsOrigin = awsEndpoint;
    }
  }
  const rawPath = await ctx.str(step.path);
  const p = awsEndpoint && !/^https?:\/\//i.test(rawPath) ? awsEndpoint + (rawPath.startsWith('/') ? '' : '/') + rawPath : rawPath;
  // Semgrep's res-render-injection takes (step, ctx, key) for Express's (req, res, next): ctx.render() evaluates the
  // step's expressions in the run scope, it never loads a file or template by name (false positive).
  const query = (await ctx.render(step.query ?? {})) as Record<string, unknown>; // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const headers = Object.fromEntries(Object.entries((await ctx.render(step.headers ?? {})) as Record<string, unknown>).map(([k, v]) => [k, stringify(v)])); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const body = step.body === undefined ? undefined : await ctx.render(step.body); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const writes = isMutating(step);
  const requestInfo = { platform: b.platform.name, method: step.method, url: joinUrl(b.baseUrl, p), query, headers, body, write: writes };
  store.updateStepInput(ctx.runId, key, ctx.redactor.apply(requestInfo));
  // another connection's credential ($secret('<other slot>', …)) in the URL, query, headers or body: refused in every
  // mode – dry runs and test runs too – before anything is sent (0.9.0)
  await scanSecrets(
    ctx,
    key,
    requestInfo.url,
    headers,
    { query, body },
    secretBindings(ctx, step.connection).filter((x) => x.foreign),
  );

  // a single-node debug run's pasted answer stands in for the platform (it is never stored as a recording)
  const pasted = ctx.debugNode?.answer;
  // test run: a write with a recorded response gets that answer; without one it is skipped as in a dry run
  const replayWrite = writes && ctx.recorded && (!!pasted || !!findRecording(b.platform.id, { method: step.method, url: p, query, body }));
  if (writes && ctx.dryRun && !replayWrite) {
    ctx.stats.skippedWrites++;
    ctx.log('info', `${ctx.recorded ? 'TEST RUN – no recorded response, would call' : 'DRY RUN – would call'} ${step.method} ${requestInfo.url}`, key, body);
    audit({
      actor: ctx.actor,
      action: 'api.write_skipped',
      entityType: 'platform',
      entityId: b.platform.id,
      runId: ctx.runId,
      summary: `Dry run: ${step.method} ${p} on "${b.platform.name}" not executed`,
      details: ctx.redactor.apply({ stepKey: key, query, body }),
    });
    return { status: 'dryrun', output: { status: 0, ok: true, dryRun: true, body: null }, summary: `DRY RUN ${step.method} ${p}` };
  }

  ctx.redactor.add(...secretValues(b.secrets));
  // every answer (page) is read into memory: at most this much (v0.3.1, it had no limit)
  const maxMb = step.maxResponseMb ?? HTTP_RESPONSE_MB.default;
  const accept = (s: number) => (step.expectStatus?.length ? step.expectStatus.includes(s) : s >= 200 && s < 300);
  let lastRecording: string | null = null;
  const replay = (url: string, q: Record<string, unknown>): HttpResult => {
    if (pasted) {
      if (lastRecording === 'pasted')
        return { status: pasted.status, ok: pasted.status < 400, headers: pasted.headers ?? {}, body: [], durationMs: 0, url } as HttpResult;
      lastRecording = 'pasted';
      ctx.log('info', `DEBUG RUN – pasted answer for ${step.method} ${url} → HTTP ${pasted.status}`, key);
      if (!accept(pasted.status)) throw new Error(`HTTP ${pasted.status} from ${step.method} ${url} (pasted): ${snippet(pasted.body)}`);
      return { status: pasted.status, ok: pasted.status < 400, headers: pasted.headers ?? {}, body: pasted.body ?? null, durationMs: 0, url } as HttpResult;
    }
    const hit = findRecording(b.platform.id, { method: step.method, url, query: q, body });
    if (!hit) throw missingRecording(b.platform.name, step.method, url, q);
    // the same recording for the next page: the recording has no more pages
    if (hit.recordingId === lastRecording) return { ...hit.result, body: [] };
    lastRecording = hit.recordingId;
    ctx.log('info', `TEST RUN – recorded response for ${step.method} ${hit.result.url} → HTTP ${hit.result.status}`, key);
    if (!accept(hit.result.status)) throw new Error(`HTTP ${hit.result.status} from ${step.method} ${url} (recorded): ${snippet(hit.result.body)}`);
    return hit.result;
  };
  const doRequest = async (url: string, q: Record<string, unknown>) => {
    // paths the kind never calls (a vault's values) – also of the platform whose origin the URL is (0.9.0): refused in
    // a test run too, before a recorded answer is looked up
    if (ctx.recorded) await assertKindRules(b.platform.kind, await buildUrl(b.platform, b.secrets, url, q), step.method);
    if (ctx.recorded) return replay(url, q);
    const target = await buildUrl(b.platform, b.secrets, url, q);
    // the AWS endpoint the step names is the platform's own origin for this call – only then, not every amazonaws.com host
    await enforceOutbound(ctx, target, { headers, body, platformOrigins: awsOrigin ? [awsOrigin] : undefined, sender: step.connection, key });
    let res: HttpResult;
    try {
      res = await platformRequest(
        b.platform,
        b.secrets,
        {
          method: step.method,
          url,
          query: q,
          headers,
          body,
          bodyType: step.bodyType,
          maxResponseBytes: maxMb * 1024 * 1024,
          ...(awsScope ? { aws: awsScope } : {}),
        },
        ctx.signal,
      );
    } catch (e) {
      if ((e as { code?: string }).code === 'ETOOLARGE')
        throw new Error(
          `The answer of ${step.method} ${url.split('?')[0]} is larger than ${maxMb} MB, the step's limit (maxResponseMb: default ${HTTP_RESPONSE_MB.default}, at most ${HTTP_RESPONSE_MB.max}) – read it in pages (pagination, a page size or filter) or raise maxResponseMb`,
        );
      throw e;
    }
    ctx.redactor.add(...secretValues(b.secrets));
    if (res.attempts && res.attempts > 1) ctx.log('warn', `${step.method} ${url} → HTTP ${res.status} after ${res.attempts} attempts`, key);
    if (!accept(res.status)) throw new Error(`HTTP ${res.status} from ${step.method} ${url}: ${snippet(res.body)}`);
    return res;
  };

  const pg = step.paginate;
  if (!pg || pg.mode === 'none') {
    const res = await doRequest(p, query);
    if (writes && !ctx.recorded) auditWrite(ctx, b, step, p, res, key);
    return {
      output: {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        body: res.body,
        durationMs: res.durationMs,
        ...(res.attempts ? { attempts: res.attempts } : {}),
      },
      summary: `${step.method} ${p} → ${res.status} (${res.durationMs} ms${res.attempts ? `, ${res.attempts} attempts` : ''})`,
    };
  }

  // ----- pagination -----
  const items: unknown[] = [];
  const maxPages = pg.maxPages ?? 500;
  const size = pg.pageSize ?? 100;
  let pages = 0;
  let lastStatus = 0;
  let totalMs = 0;
  const extract = async (bodyVal: unknown): Promise<unknown[]> => {
    if (pg.itemsPath) {
      const v = await ctx.data(pg.itemsPath, bodyVal);
      return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
    }
    if (Array.isArray(bodyVal)) return bodyVal;
    const o = bodyVal as Record<string, unknown> | null;
    if (pg.mode === 'scim') return ((o?.resources ?? o?.Resources) as unknown[]) ?? [];
    const emb = o?._embedded as Record<string, unknown> | undefined;
    if (emb) {
      const first = Object.values(emb).find(Array.isArray);
      if (first) return first as unknown[];
    }
    const arr = o && Object.values(o).find(Array.isArray);
    return (arr as unknown[]) ?? [];
  };

  if (pg.mode === 'scim') {
    let start = 1;
    for (;;) {
      const res = await doRequest(p, { ...query, [pg.pageParam ?? 'startIndex']: start, [pg.sizeParam ?? 'count']: size });
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      const page = await extract(res.body);
      items.push(...page);
      const total = Number((res.body as { totalResults?: number })?.totalResults ?? 0);
      start += page.length || size;
      if (page.length === 0 || start > total || pages >= maxPages) break;
    }
  } else if (pg.mode === 'page' || pg.mode === 'offset') {
    let pageNo = pg.mode === 'page' ? (pg.firstPage ?? 0) : 0;
    for (;;) {
      const q =
        pg.mode === 'page'
          ? { ...query, [pg.pageParam ?? 'page']: pageNo, [pg.sizeParam ?? 'size']: size }
          : { ...query, [pg.pageParam ?? 'offset']: pageNo, [pg.sizeParam ?? 'limit']: size };
      const res = await doRequest(p, q);
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      const page = await extract(res.body);
      items.push(...page);
      if (page.length === 0 || pages >= maxPages) break;
      // the API says whether more follow (hasNext): a short page is then not the end
      const more = pg.morePath ? await ctx.data(pg.morePath, res.body) : undefined;
      if (pg.morePath && !more) break;
      if (pg.mode === 'page') {
        const totalPages = Number(await ctx.data(pg.totalPagesPath ?? 'page.totalPages', res.body));
        pageNo++;
        if (Number.isFinite(totalPages) && totalPages > 0) {
          if (pageNo - (pg.firstPage ?? 0) >= totalPages) break;
        } else if (page.length < size && !pg.morePath) break;
      } else {
        pageNo += page.length;
        if (page.length < size && !pg.morePath) break;
      }
    }
  } else if (pg.mode === 'nextLink') {
    let url: string | undefined = p;
    let q: Record<string, unknown> = query;
    while (url) {
      const res = await doRequest(url, q);
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      items.push(...(await extract(res.body)));
      const next = await ctx.data(pg.nextPath ?? '_links.next.href', res.body);
      url = typeof next === 'string' && next ? next : undefined;
      q = {};
      if (pages >= maxPages) break;
    }
  }
  if (pages >= maxPages) ctx.log('warn', `Stopped after ${maxPages} pages (maxPages)`, key);
  return {
    output: { status: lastStatus, ok: true, body: items, pages, durationMs: totalMs },
    summary: `${step.method} ${p} → ${items.length} item(s) in ${pages} page(s)`,
  };
}

function auditWrite(ctx: StepContext, b: Binding, step: NodeOf<'http'>, p: string, res: HttpResult, key: string) {
  ctx.stats.writes++;
  audit({
    actor: ctx.actor,
    action: 'api.write',
    entityType: 'platform',
    entityId: b.platform.id,
    runId: ctx.runId,
    summary: `${step.method} ${p} on "${b.platform.name}" → HTTP ${res.status}`,
    details: { stepKey: key, status: res.status, durationMs: res.durationMs },
  });
}

function joinUrl(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  return base + (p.startsWith('/') ? '' : '/') + p;
}

function snippet(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, 400);
}
