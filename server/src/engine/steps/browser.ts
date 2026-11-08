import fs from 'node:fs';
import path from 'node:path';
import type { NodeOf } from '@sm/shared';
import { audit } from '../../audit.js';
import { config } from '../../config.js';
import { logger } from '../../log.js';
import { assertAddressSafe, assertOutboundAllowed } from '../../platforms/outbound.js';
import { destinationKinds } from '../../platforms/restrictedOrigins.js';
import { getSettings } from '../../settings.js';
import { HttpError, newId, pathInside, sha256 } from '../../util.js';
import { openBrowser, type BrowserSession } from '../browser.js';
import type { Bindings } from '../expr.js';
import * as store from '../store.js';
import { Cancelled, connectionSources, type LeafResult, type StepContext, type StepExecutor } from './context.js';
import { engineOutboundContext, enforceOutbound, originOfSafe, scanSecrets, secretBindings } from './outbound.js';

/**
 * "Browser": actions in a headless Chromium (engine/browser.ts), one browser per run, closed by the engine when the run
 * ends. Navigation obeys the outbound policy, values put into a page pass the egress scan, screenshots are evidence.
 */
export const browserStep: StepExecutor<'browser'> = {
  type: 'browser',
  exec: execBrowser,
  sources: (step, ctx) => connectionSources(step.connection, ctx),
};

/** Where a run's evidence file (screenshot) is stored: data folder/artifacts/<run id>/<file>. */
const artifactFile = (runId: string, name: string): string => pathInside(path.join(config.dataDir, 'artifacts'), runId, name);

/**
 * A browser step never opens the origin of a platform of a kind with rules of its own – read-only kinds (Kafka Connect,
 * changedetection.io, container registries) and kinds with refused paths (IBM Verify Privilege Vault): the page could
 * send anything there (0.9.0). 403 BROWSER_RESTRICTED_ORIGIN.
 */
async function assertBrowserDestination(url: string): Promise<void> {
  const kinds = await destinationKinds(url);
  if (!kinds.length) return;
  const origin = originOfSafe(url) || url.slice(0, 120);
  throw Object.assign(
    new HttpError(
      403,
      `Blocked: ${origin} belongs to a platform of kind ${kinds.join(', ')}, whose rules (read-only, refused paths) a browser step cannot keep – browser steps never open it; use an http step on its connection`,
      'BROWSER_RESTRICTED_ORIGIN',
      { origin, kind: kinds.join(', ') },
    ),
    { retryable: false },
  );
}

async function execBrowser(step: NodeOf<'browser'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = step.connection ? ctx.bindings[step.connection] : undefined;
  if (step.connection && !b) throw new Error(`Connection "${step.connection}" is not bound`);
  if (ctx.recorded) {
    ctx.log('info', 'TEST RUN – browser steps do not run in test runs (they would open the real site)', key);
    return { status: 'dryrun', output: { dryRun: true, recorded: true }, summary: 'TEST RUN – skipped' };
  }
  if (step.mutating && ctx.dryRun) {
    ctx.stats.skippedWrites++;
    ctx.log('info', 'DRY RUN – browser step changes data and was skipped', key);
    return { status: 'dryrun', output: { dryRun: true }, summary: 'DRY RUN – skipped' };
  }
  const settings = getSettings();
  if (!ctx.browser) {
    const outCtx = engineOutboundContext();
    ctx.browser = await openBrowser({
      headless: settings.browserHeadless,
      timeoutMs: settings.browserTimeoutMs,
      ignoreHttpsErrors: !!b?.platform.config.http?.insecureTls,
      // Navigation obeys the full outbound policy; sub-resources need only be address-safe
      // (metadata / link-local / own port), so portals that pull assets from CDNs still load.
      requestGuard: async (url, navigation) => {
        try {
          if (navigation) await assertOutboundAllowed(url, outCtx);
          else await assertAddressSafe(url);
          // the origin of a platform of a kind with rules of its own (read-only, refused paths): never from a browser,
          // whose requests those rules cannot see (0.9.0)
          await assertBrowserDestination(url);
          return true;
        } catch (e) {
          // the page only sees "net::ERR_BLOCKED_BY_CLIENT": say what was blocked and why (v0.3.1)
          let origin = url;
          try {
            origin = new URL(url).origin;
          } catch {
            /* keep the text */
          }
          if (navigation) {
            const msg = blockedNavigation(origin, e);
            if (!ctx.browserBlocked.includes(msg)) ctx.browserBlocked.push(msg);
            ctx.log('warn', `Browser: ${msg}`);
          } else ctx.log('debug', `Browser: a sub-request to ${origin} was blocked (${(e as Error).message.slice(0, 200)})`);
          return false;
        }
      },
      // a redirect hop the policy refuses has already been sent by Chromium: the step stops using the page
      onRefusedRedirect: (url) => ctx.browserRedirects.push(url),
    });
  }
  const page = ctx.browser.page;
  const portal = b ? (await ctx.str(b.platform.config.portalUrl || b.baseUrl, { vars: b.platform.config.variables })).replace(/\/+$/, '') : '';
  let portalOrigin = '';
  try {
    if (portal) portalOrigin = new URL(portal).origin;
  } catch {
    /* not a URL: no portal origin is allowed */
  }
  // The bound platform's own portal is a legitimate destination for its secrets (e.g. a login form); the secrets of the
  // run's other connections may not be put into the page at all (0.9.0)
  const browserBindings = secretBindings(ctx, b ? step.connection! : null).map((sb) =>
    !sb.foreign ? { ...sb, allowed: async (url: string) => (await sb.allowed(url)) || (!!portalOrigin && originOfSafe(url) === portalOrigin) } : sb,
  );
  const extracted: Record<string, unknown> = {};
  const blockedBefore = ctx.browserBlocked.length;
  const blockedNow = () => ctx.browserBlocked.slice(blockedBefore);
  const shots: { id: string; name: string; sha256: string }[] = [];
  const done: string[] = [];
  const extraBindings: Bindings = { page: () => ({ url: page.url() }) };
  // Actions that change the page rather than just read it. In a dry run these still
  // run (so a non-"mutating" browser step can change data in the target portal);
  // dryRunReadOnly skips them, and we warn once when they run in a dry run otherwise.
  const INTERACTION = new Set(['click', 'fill', 'press', 'select', 'check', 'evaluate']);
  let warnedDryInteraction = false;
  for (const [i, a] of step.actions.entries()) {
    if (ctx.signal.aborted) throw new Cancelled();
    const sel = a.selector ? await ctx.str(a.selector) : '';
    const val = a.value !== undefined ? await ctx.str(a.value, { ...extraBindings, extracted }) : '';
    const opts = a.timeoutMs ? { timeout: a.timeoutMs } : undefined;
    const label = `${i + 1}. ${a.action}${sel ? ` ${sel}` : ''}`;
    if (ctx.dryRun && INTERACTION.has(a.action)) {
      if (step.dryRunReadOnly) {
        ctx.stats.skippedWrites++;
        done.push(`${label} (skipped – dry run, read-only)`);
        continue;
      }
      if (!warnedDryInteraction) {
        warnedDryInteraction = true;
        ctx.log(
          'warn',
          'DRY RUN – this browser step performs page interactions (click/fill/…) that may change data in the portal. Mark the step "changes data" or set dryRunReadOnly to skip them.',
          key,
        );
      }
    }
    // An action that puts a value into the page would send it to the page's current origin:
    // make sure it is not a platform secret bound for an origin the page is not.
    if (val && ['fill', 'press', 'select', 'evaluate'].includes(a.action)) {
      await scanSecrets(ctx, key, page.url() || portal || 'about:blank', {}, val, browserBindings);
    }
    try {
      switch (a.action) {
        case 'goto': {
          const url = /^https?:/i.test(val) ? val : portal + (val.startsWith('/') ? '' : '/') + val;
          await enforceOutbound(ctx, url, { sender: b ? step.connection! : null, key });
          await assertBrowserDestination(url);
          await page.goto(url, { waitUntil: 'domcontentloaded', ...(opts ?? {}) });
          done.push(`${label} ${url}`);
          break;
        }
        case 'click':
          await page.click(sel, opts);
          break;
        case 'fill':
          await page.fill(sel, val, opts);
          break;
        case 'press':
          await page.press(sel || 'body', val, opts);
          break;
        case 'select':
          await page.selectOption(sel, val, opts);
          break;
        case 'check':
          await page.check(sel, opts);
          break;
        case 'waitFor':
          await page.waitForSelector(sel, { state: a.state ?? 'visible', ...(opts ?? {}) });
          break;
        case 'expectText': {
          const text = (await page.textContent(sel || 'body', opts)) ?? '';
          if (!text.includes(val)) throw new Error(`Expected "${val}" in ${sel || 'page'}, found "${text.trim().slice(0, 200)}"`);
          break;
        }
        case 'extract': {
          let v: unknown;
          if (a.all) {
            v = await page.$$eval(sel, (els, attr) => els.map((e) => (attr ? e.getAttribute(attr as string) : (e.textContent ?? '').trim())), a.attribute);
          } else if (a.attribute) v = await page.getAttribute(sel, a.attribute, opts);
          else v = ((await page.textContent(sel, opts)) ?? '').trim();
          extracted[a.as ?? `value${i + 1}`] = v;
          break;
        }
        case 'screenshot': {
          const buf = await page.screenshot({ fullPage: !!a.fullPage, type: 'png' });
          const id = newId('art_');
          const file = artifactFile(ctx.runId, `${id}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
          const hash = sha256(buf);
          const name = a.name || `screenshot-${i + 1}`;
          store.addArtifact({ id, runId: ctx.runId, stepKey: key, kind: 'screenshot', name, mime: 'image/png', path: file, sha256: hash, size: buf.length });
          shots.push({ id, name, sha256: hash });
          break;
        }
        case 'wait':
          await page.waitForTimeout(Number(val) || 1000);
          break;
        case 'evaluate': {
          const v = await page.evaluate(val);
          if (a.as) extracted[a.as] = v;
          break;
        }
      }
      // actions that can navigate: a refused redirect hop is reported by the time the action is done (or just after)
      await refusedRedirects(ctx, page, ['goto', 'click', 'press'].includes(a.action) ? 50 : 0);
      if (a.action !== 'goto') done.push(label);
    } catch (e) {
      // capture evidence of the failure
      try {
        const buf = await page.screenshot({ type: 'png' });
        const id = newId('art_');
        const file = artifactFile(ctx.runId, `${id}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        store.addArtifact({
          id,
          runId: ctx.runId,
          stepKey: key,
          kind: 'screenshot',
          name: `failure-${i + 1}`,
          mime: 'image/png',
          path: file,
          sha256: sha256(buf),
          size: buf.length,
        });
      } catch (err) {
        // the step's own error is what the run reports; a missing screenshot only shows in the log
        logger.warn({ err, runId: ctx.runId, step: key }, 'could not save the failure screenshot');
      }
      const blocked = blockedNow();
      throw new Error(`Browser action ${label} failed: ${(e as Error).message.split('\n')[0]}${blocked.length ? ` – ${blocked.join('; ')}` : ''}`);
    }
  }
  if (shots.length) {
    audit({
      actor: ctx.actor,
      action: 'browser.evidence',
      entityType: 'run',
      entityId: ctx.runId,
      runId: ctx.runId,
      summary: `${shots.length} screenshot(s) captured in "${step.name || step.id}"`,
      details: { stepKey: key, screenshots: shots },
    });
  }
  await refusedRedirects(ctx, page, 50).catch((e: Error) => {
    throw new Error(`Browser step: ${e.message} – ${blockedNow().join('; ')}`);
  });
  store.updateStepInput(ctx.runId, key, { actions: done });
  const blocked = blockedNow();
  return {
    output: { ...extracted, url: page.url(), title: await page.title(), screenshots: shots, ...(blocked.length ? { blockedByPolicy: blocked } : {}) },
    summary: `${step.actions.length} action(s)${shots.length ? `, ${shots.length} screenshot(s)` : ''}${blocked.length ? `, ${blocked.length} navigation(s) blocked by the outbound policy` : ''}`,
  };
}

/**
 * Redirect hops the policy refuses (reported after Chromium sent them): the page is left for about:blank so nothing
 * of that origin is read or filled in, and the action fails with what was blocked.
 */
async function refusedRedirects(ctx: StepContext, page: BrowserSession['page'], waitMs: number): Promise<void> {
  // the check of a hop finishes just after the navigation that caused it
  if (!ctx.browserRedirects.length && waitMs) await new Promise((r) => setTimeout(r, waitMs));
  if (!ctx.browserRedirects.length) return;
  const urls = ctx.browserRedirects.splice(0);
  const origins = [...new Set(urls.map((u) => originOfSafe(u) || u))];
  const msgs = origins.map((o) => blockedNavigation(o, new Error('outbound policy')));
  for (const m of msgs) {
    if (!ctx.browserBlocked.includes(m)) ctx.browserBlocked.push(m);
    ctx.log('warn', `Browser: a redirect was ${m}`);
  }
  await page.goto('about:blank').catch(() => undefined); // leaving the page is best effort: the error below is what counts
  throw new Error(`the page was redirected to ${origins.join(', ')}, which the outbound policy does not allow`);
}

/** A page navigation the policy refused, in plain words: what, and how to allow it. */
export function blockedNavigation(origin: string, e: unknown): string {
  const m = (e as Error)?.message ?? '';
  if (/outbound policy/i.test(m))
    return `blocked by the outbound policy: ${origin} – add it to the platform's trusted origins or the allow-list (Settings → Security & sign-in → Outbound access)`;
  return `blocked: ${origin} – ${m.slice(0, 200)}`;
}
