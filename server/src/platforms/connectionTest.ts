import { platformKind, type Platform } from '@sm/shared';
import type { HttpResult } from './http.js';
import { authHint, isEmptyBody, isHtml, isJson, redirectHint, where } from './answers.js';

/**
 * The verdict of "Test connection" on an HTTP platform (v0.3.1). A status below 400 alone is not enough: a base URL
 * that redirects to a sign-in page, or a portal answering with its HTML page, used to report "Connection works".
 *
 *   3xx left over                              failed – where it redirected to
 *   2xx HTML from a kind with a known API      failed – an HTML page, not the API
 *   2xx not JSON from a kind with a known API  failed – what it was instead
 *   2xx HTML after a redirect (any kind)       failed – a sign-in page, most likely
 *   Prometheus without {"status":"success"}    failed
 */

export interface TestVerdict {
  ok: boolean;
  message: string;
}

export function judgeHttpTest(p: Platform, what: string, requestedUrl: string, res: HttpResult): TestVerdict {
  const redirected = where(res.url) !== where(requestedUrl);
  const via = redirected ? ` (redirected to ${where(res.url)})` : '';
  // the kind's descriptor: whether its test path is a JSON API, and the API base URL it expects (the hints)
  const example = platformKind(p.kind)?.apiExample;
  const empty = isEmptyBody(res.body) ? ' with an empty response' : '';
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.location;
    return {
      ok: false,
      message: `${what} answered HTTP ${res.status}${loc ? ` – ${redirectHint(loc, res.url, example)}` : ' (a redirect without a target)'}`,
    };
  }
  if (res.status >= 400 || res.status < 200) {
    const hint =
      res.status === 401 || res.status === 403
        ? ` – ${authHint(p, res.status)}`
        : res.status === 404 && example
          ? ` – is the base URL the API (${example})?`
          : '';
    return { ok: false, message: `${what} answered HTTP ${res.status}${empty}${via}${hint}` };
  }
  const html = isHtml(res);
  const apiKind = platformKind(p.kind)?.jsonApi ?? false;
  if (html && (apiKind || redirected))
    return {
      ok: false,
      message: `${what} answered with an HTML page${via}, not the API – is the base URL the API${example ? ` (${example})` : ''}, and reachable without browser sign-in?`,
    };
  if (apiKind && !isJson(res)) {
    const ct = res.headers['content-type'];
    return {
      ok: false,
      message: `${what} answered HTTP ${res.status}${empty || ` with ${ct ? ct.split(';')[0] : 'no content type'}`}${via}, not JSON – is the base URL the API${example ? ` (${example})` : ''}?`,
    };
  }
  if (p.kind === 'prometheus' && (res.body as { status?: unknown } | null)?.status !== 'success')
    return { ok: false, message: `${what} answered without {"status":"success"}${via} – not a Prometheus query API (docs/PROMETHEUS.md)` };
  const note = html ? ' – it answered with an HTML page: fine for a portal, for an API set the test path to an API endpoint' : '';
  return { ok: true, message: `Connection works – ${what}${via}${note}` };
}
