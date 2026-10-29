import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { animationsDone } from './axe';
import { appHref } from './env';

/** Unique, readable names so parallel tests never collide. */
export function uniq(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function json<T = any>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()} → HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

export async function platformId(api: APIRequestContext, kind: 'insights-hub' | 'industrial-edge-management'): Promise<string> {
  const list = await json<{ id: string; kind: string; name: string }[]>(await api.get('/api/platforms'));
  const p = list.find((x) => x.kind === kind && x.name.endsWith('(demo)'));
  if (!p) throw new Error(`no demo platform of kind ${kind}`);
  return p.id;
}

/** Starts a run through the API (bound to the demo Insights Hub unless bindings are given). */
export async function startRunApi(
  api: APIRequestContext,
  processId: string,
  opts: { dryRun?: boolean; inputs?: Record<string, unknown>; bindings?: Record<string, string> } = {},
): Promise<string> {
  const bindings = opts.bindings ?? { hub: await platformId(api, 'insights-hub') };
  const r = await json<{ id: string }>(await api.post('/api/runs', { data: { processId, dryRun: opts.dryRun ?? true, inputs: opts.inputs ?? {}, bindings } }));
  return r.id;
}

export async function waitForRun(api: APIRequestContext, runId: string, statuses: string[], timeoutMs = 30_000): Promise<any> {
  let last: any;
  await expect
    .poll(
      async () => {
        last = await json(await api.get(`/api/runs/${runId}`));
        return statuses.includes(last.status) ? 'reached' : `status ${last.status}`;
      },
      { timeout: timeoutMs, message: `run ${runId} to reach ${statuses.join('/')}` },
    )
    .toBe('reached');
  return last;
}

/** Picks an option of a Mantine Select / combobox identified by its label. */
export async function chooseOption(page: Page, label: string | RegExp, option: string | RegExp): Promise<void> {
  await page.getByRole('textbox', { name: label }).click();
  // the dropdown (and a dialog that just opened) moves while its transition runs: click once it stands still
  await animationsDone(page);
  await page.getByRole('option', { name: option }).click();
}

/** Run dialog: bind the "hub" slot to the demo Insights Hub, choose dry/real run and start. Returns the run id. */
/** Picks a run mode (#137) in a run dialog or a schedule or trigger form. */
export async function chooseRunMode(scope: Locator, mode: 'Dry run' | 'Test run' | 'Run'): Promise<void> {
  const control = scope.getByTestId('run-mode');
  await control.getByText(mode, { exact: true }).click();
  await expect(control.getByRole('radio', { name: mode, exact: true })).toBeChecked();
}

export async function startRunFromDialog(page: Page, opts: { dryRun: boolean; platform?: RegExp } = { dryRun: true }): Promise<string> {
  const dialog = page.getByRole('dialog', { name: /^Run: / });
  await expect(dialog).toBeVisible();
  const slot = dialog.getByRole('textbox', { name: /^Connection "/ }).first();
  if (!(await slot.inputValue())) {
    await slot.click();
    await page.getByRole('option', { name: opts.platform ?? /Insights Hub \(demo\)/ }).click();
  }
  await chooseRunMode(dialog, opts.dryRun ? 'Dry run' : 'Run');
  await dialog.getByRole('button', { name: opts.dryRun ? 'Start dry run' : 'Start run' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  return page.url().split('/').pop()!;
}

/** Task panels ("Task: <title>" regions) – on the My tasks page optionally narrowed to one run. */
export function taskRegion(page: Page, opts: { title?: RegExp; runId?: string } = {}): Locator {
  let l = page.getByRole('region', { name: opts.title ?? /^Task: / });
  if (opts.runId) l = l.filter({ has: page.locator(`a[href="${appHref(`/runs/${opts.runId}`)}"]`) });
  return l;
}

/** No horizontal page scroll (mobile layout check). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  // Retried: right after a viewport change the layout is still settling (the navbar collapses with a
  // transition); a real overflow still fails once the timeout is over.
  const measure = () => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  await expect
    .poll(
      async () => {
        const { scrollWidth, innerWidth } = await measure();
        return scrollWidth - innerWidth;
      },
      { message: 'the page must not be wider than the screen', timeout: 5_000 },
    )
    .toBeLessThanOrEqual(0);
}

/** Waits until the app shell (header with the user menu) is rendered. */
export async function expectShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
}

/**
 * The themed confirmation dialog (web/src/components/confirm.tsx): waits for it, optionally checks
 * its message and clicks the confirm button (by its label, e.g. "Delete").
 */
export async function confirmDialog(page: Page, button: string, opts: { title?: string | RegExp; message?: string | RegExp } = {}): Promise<void> {
  const dialog = page.getByRole('dialog', opts.title ? { name: opts.title } : {}).filter({ has: page.getByTestId('confirm-dialog-confirm') });
  await expect(dialog).toBeVisible();
  if (opts.message) await expect(dialog.getByTestId('confirm-dialog-message')).toContainText(opts.message);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}
