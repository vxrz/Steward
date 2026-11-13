import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Wait until finite animations and transitions (dialog and palette fades) have finished. axe measures
 * colours as they are drawn, so a scan during a fade-in reports contrast problems that do not exist.
 */
export async function animationsDone(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/**
 * axe-core WCAG 2.1 A/AA scan; fails on "serious" or "critical" violations (same rules as accessibility.spec.ts).
 * `wcag22`: also the WCAG 2.2 AA rules (target size) – for the pages that already meet them.
 */
export async function expectAccessible(page: Page, name: string, opts: { wcag22?: boolean } = {}) {
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', ...(opts.wcag22 ? ['wcag22aa'] : [])];
  const scan = async () => {
    await animationsDone(page);
    const result = await new AxeBuilder({ page }).withTags(tags).analyze();
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  };
  let bad = await scan();
  // a notification that appeared after the wait is still fading in: its colours are not final yet – scan once more
  const inNotification = (v: (typeof bad)[number]) => v.nodes.every((n) => n.target.join(' ').includes('mantine-Notification'));
  if (bad.length && bad.every(inNotification)) {
    await page.waitForTimeout(500);
    bad = await scan();
  }
  const report = bad.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help}\n${v.nodes
        .slice(0, 5)
        .map((n) => `   ${n.target.join(' ')}\n     ${n.failureSummary?.split('\n').join(' ')}`)
        .join('\n')}`,
  );
  expect(report, `accessibility violations on ${name}`).toEqual([]);
}

/** Wait for the page content (lazy routes, queries) before scanning. */
export async function settle(page: Page) {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}
