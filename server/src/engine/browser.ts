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

export async function openBrowser(opts: { headless: boolean; timeoutMs: number; ignoreHttpsErrors?: boolean }): Promise<BrowserSession> {
  let pw: { chromium: { launch(o: unknown): Promise<{ newContext(o: unknown): Promise<{ newPage(): Promise<PwPage> }>; close(): Promise<void> }> } };
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
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs);
  return { page, close: () => browser.close() };
}
