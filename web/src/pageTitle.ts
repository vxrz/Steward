import { useEffect } from 'react';

/**
 * The browser tab names the page (WCAG 2.4.2): "Schedules – Steward", "Kubernetes namespace shop-prod – Steward".
 * Taken from the page's own heading (its `h1` in the main region; without a status badge beside the name, see
 * `data-page-title` in DetailHeader), so every page gets it without code of its own and a
 * detail page shows its item once it has loaded; the history, bookmarks and screen readers announce it on navigation.
 */
/** The name in a heading, without the status badges, notes and buttons some pages put beside it. */
function headingText(h: Element | null): string {
  if (!h) return '';
  const copy = h.cloneNode(true) as Element;
  copy.querySelectorAll('.mantine-Badge-root, button, [role="status"], [aria-hidden="true"]').forEach((e) => e.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function usePageTitle(mainId: string, appName: string, pathname: string): void {
  useEffect(() => {
    const main = document.getElementById(mainId);
    if (!main) return;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      // after the commit and after the theme's own title (an effect of a parent runs after this one)
      frame = requestAnimationFrame(() => {
        const heading = headingText(main.querySelector('h1 [data-page-title]') ?? main.querySelector('h1'));
        const title = heading && heading !== appName ? `${heading} – ${appName}` : appName;
        if (document.title !== title) document.title = title;
      });
    };
    apply();
    // the heading arrives with the page's data (lazy pages, detail pages) and changes with it
    const observer = new MutationObserver(apply);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mainId, appName, pathname]);
}
