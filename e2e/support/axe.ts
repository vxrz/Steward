import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

/**
 * Wait until finite animations and transitions (dialog and palette fades) have finished. axe measures
 * colours as they are drawn, so a scan during a fade-in reports contrast problems that do not exist.
 */
export async function animationsDone(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

type MotionWindow = Window & { __axeMotion?: boolean; __axeMotionWatched?: boolean };

/** From now on, note in the page when a transition or a finite animation starts (endless ones such as loaders do not count). */
async function watchMotion(page: Page) {
  await page.evaluate(() => {
    const w = window as MotionWindow;
    w.__axeMotion = false;
    if (w.__axeMotionWatched) return;
    w.__axeMotionWatched = true;
    document.addEventListener('transitionrun', () => (w.__axeMotion = true), true);
    document.addEventListener(
      'animationstart',
      (e) => {
        const endless = (e.target as Element)
          .getAnimations()
          .some((a) => (a as CSSAnimation).animationName === e.animationName && a.effect?.getTiming().iterations === Infinity);
        if (!endless) w.__axeMotion = true;
      },
      true,
    );
  });
}

/** Whether something started moving since watchMotion(), or is still moving. */
async function moved(page: Page) {
  return page.evaluate(
    () =>
      !!(window as MotionWindow).__axeMotion ||
      document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity),
  );
}

/** The violations a scan fails on. */
export const seriousViolations = (result: AxeResults) => result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

/**
 * An axe scan of a page that holds still. animationsDone() only covers what moves when the scan starts, but
 * a scan takes a while (seconds on a loaded machine) and something can start fading during it. The usual
 * case is a toast whose auto-close timer runs out mid-scan: axe then measures the half-transparent toast
 * over the page or a dialog's backdrop (e.g. #545454 on #b9b9b9) and reports a contrast problem nobody
 * ever sees. So a scan that failed while something moved is repeated once the page is still again. All
 * rules apply every time, and the last scan counts.
 */
export async function analyzeStill(page: Page, builder: () => AxeBuilder, attempts = 3): Promise<AxeResults> {
  for (let i = 1; ; i++) {
    await animationsDone(page);
    await watchMotion(page);
    const result = await builder().analyze();
    if (i >= attempts || seriousViolations(result).length === 0 || !(await moved(page))) return result;
  }
}

/** Failure message lines: rule, impact and the first few elements of each violation. */
export function violationReport(violations: AxeResults['violations']) {
  return violations.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help}\n${v.nodes
        .slice(0, 5)
        .map((n) => `   ${n.target.join(' ')}\n     ${n.failureSummary?.split('\n').join(' ')}`)
        .join('\n')}`,
  );
}

/** axe-core WCAG 2.1 A/AA scan; fails on "serious" or "critical" violations (same rules as accessibility.spec.ts). */
export async function expectAccessible(page: Page, name: string) {
  const result = await analyzeStill(page, () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']));
  expect(violationReport(seriousViolations(result)), `accessibility violations on ${name}`).toEqual([]);
}

/** Wait for the page content (lazy routes, queries) before scanning. */
export async function settle(page: Page) {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}
