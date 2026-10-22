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

export async function openBrowser(opts: { headless: boolean; timeoutMs: number; ignoreHttpsErrors?: boolean; requestGuard?: BrowserRequestGuard }): Promise<BrowserSession> {
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
    throw new Error(
      'Browser automation needs Playwright: run "npm install playwright -w server" and "npx playwright install chromium".',
    );
  }
  const executablePath = EXECUTABLE_CANDIDATES.find((p) => fs.existsSync(p));
  const browser = await pw.chromium.launch({ headless: opts.headless, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: !!opts.ignoreHttpsErrors, viewport: { width: 1366, height: 860 } });
  if (opts.requestGuard) {
    const guard = opts.requestGuard;
    // Enforce the outbound policy on every browser request, including sub-resources
    // (the browser uses Chromium's own network stack, not our guarded dispatcher).
    await context.route('**/*', async (route) => {
      let ok = false;
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
