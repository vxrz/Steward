import fs from 'node:fs';

/**
 * Thin wrapper around Playwright. Playwright is an optional dependency –
 * when it is missing, browser steps fail with a helpful message.
 */

// Minimal structural types so we do not depend on Playwright typings.
export interface PwPage {
  goto(url: string, o?: unknown): Promise<unknown>;
  click(sel: string, o?: unknown): Promise<void>;
  fill(sel: string, v: string, o?: unknown): Promise<void>;
  press(sel: string, key: string, o?: unknown): Promise<void>;
  selectOption(sel: string, v: string, o?: unknown): Promise<unknown>;
  check(sel: string, o?: unknown): Promise<void>;
  waitForSelector(sel: string, o?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  textContent(sel: string, o?: unknown): Promise<string | null>;
  getAttribute(sel: string, name: string, o?: unknown): Promise<string | null>;
  $$eval(sel: string, fn: (els: Element[], attr?: string) => unknown, arg?: unknown): Promise<unknown>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(o: { fullPage?: boolean; type?: 'png' }): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  setDefaultTimeout(ms: number): void;
}

export interface BrowserSession {
  page: PwPage;
  close(): Promise<void>;
}

/**
 * Decide whether the browser may issue a request. `navigation` is true for a
 * top-level page navigation (the process-controlled destination) and false for
 * sub-resources (scripts, images, XHR). Returning false aborts the request.
 */
export type BrowserRequestGuard = (url: string, navigation: boolean) => Promise<boolean> | boolean;

interface PwRoute {
  request(): { url(): string; isNavigationRequest(): boolean };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

const EXECUTABLE_CANDIDATES = [process.env.SM_CHROMIUM_PATH].filter(Boolean) as string[];

let available: boolean | undefined;
export async function browserAvailable(): Promise<boolean> {
  if (available !== undefined) return available;
  try {
    await import('playwright');
    available = true;
  } catch {
    available = false;
  }
  return available;
}

type PwBrowser = {
  newContext(o: unknown): Promise<{ newPage(): Promise<PwPage>; route(pattern: string, handler: (r: PwRoute) => Promise<void>): Promise<void> }>;
  close(): Promise<void>;
};

export async function openBrowser(opts: {
  headless: boolean;
  timeoutMs: number;
  ignoreHttpsErrors?: boolean;
  requestGuard?: BrowserRequestGuard;
}): Promise<BrowserSession> {
  let pw: {
    chromium: {
      launch(o: unknown): Promise<{
        newContext(o: unknown): Promise<{ newPage(): Promise<PwPage>; route(pattern: string, handler: (r: PwRoute) => Promise<void>): Promise<void> }>;
        close(): Promise<void>;
      }>;
    };
  };
  try {
    pw = (await import('playwright')) as never;
  } catch {
    throw new Error('Browser automation needs Playwright: run "npm install playwright -w server" and "npx playwright install chromium".');
  }
  const executablePath = EXECUTABLE_CANDIDATES.find((p) => fs.existsSync(p));
  const browser = await launchChromium(pw, { headless: opts.headless, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: !!opts.ignoreHttpsErrors, viewport: { width: 1366, height: 860 } });
  if (opts.requestGuard) {
    const guard = opts.requestGuard;
    // Enforce the outbound policy on every browser request, including sub-resources
    // (the browser uses Chromium's own network stack, not our guarded dispatcher).
    await context.route('**/*', async (route) => {
      let ok: boolean;
      try {
        ok = await guard(route.request().url(), route.request().isNavigationRequest());
      } catch {
        ok = false;
      }
      await (ok ? route.continue() : route.abort('blockedbyclient')).catch(() => undefined);
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs);
  return { page, close: () => browser.close() };
}

// ---------- launch hardening (review C, H5) ----------

/** Variables the browser may see. Everything else – in particular SM_* settings and secrets – stays in the server process. */
const BROWSER_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|FONTCONFIG_[A-Z_]+|SYSTEMROOT|WINDIR|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|COMPUTERNAME|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|PLAYWRIGHT_BROWSERS_PATH)$/i;

export function browserEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && BROWSER_ENV.test(e[0]) && !/^SM_/i.test(e[0])),
  );
}

/**
 * Chromium's sandbox is on unless it cannot work: as root (typical in containers) Chromium refuses to
 * start with it. SM_CHROMIUM_SANDBOX=1 forces it on, =0 off. When the sandbox is wanted but the
 * launch fails (e.g. no user namespaces in a container), the browser starts without it once and a
 * warning is logged – set SM_CHROMIUM_SANDBOX=0 to silence it, or give the container what Chromium needs.
 */
export function sandboxWanted(env: NodeJS.ProcessEnv = process.env): { sandbox: boolean; forced: boolean } {
  const v = env.SM_CHROMIUM_SANDBOX?.trim();
  if (v === '1' || v === 'true') return { sandbox: true, forced: true };
  if (v === '0' || v === 'false') return { sandbox: false, forced: true };
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  return { sandbox: !root, forced: false };
}

let sandboxFallbackLogged = false;

async function launchChromium(pw: { chromium: { launch(o: unknown): Promise<PwBrowser> } }, o: Record<string, unknown>) {
  const { sandbox, forced } = sandboxWanted();
  const base = { ...o, env: browserEnv() };
  try {
    return await pw.chromium.launch({ ...base, chromiumSandbox: sandbox });
  } catch (e) {
    if (!sandbox || forced) throw e;
    if (!sandboxFallbackLogged) {
      sandboxFallbackLogged = true;
      const { logger } = await import('../log.js');
      logger.warn(
        { err: (e as Error).message.slice(0, 300) },
        'Chromium could not start with its sandbox – browser steps run without it (set SM_CHROMIUM_SANDBOX=0 to accept, see docs/SECURITY-HARDENING.md)',
      );
    }
    return pw.chromium.launch({ ...base, chromiumSandbox: false });
  }
}
