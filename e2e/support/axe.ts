import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Wait until finite animations and transitions (dialog and palette fades) have finished. axe measures
 * colours as they are drawn, so a scan during a fade-in reports contrast problems that do not exist.
 */
export async function animationsDone(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/** axe-core WCAG 2.1 A/AA scan; fails on "serious" or "critical" violations (same rules as accessibility.spec.ts). */
export async function expectAccessible(page: Page, name: string) {
  await animationsDone(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
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
  await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}
