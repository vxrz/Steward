/**
 * Focus goes back to the control that opened a dialog when the dialog closes (WCAG 2.4.3 focus order).
 *
 * Mantine returns the focus only in the exit transition of a modal that stays mounted. Most dialogs of the app are
 * mounted while they are open (`{open && <XModal />}`): when they unmount, the focus is lost to the page's <body> and
 * a keyboard or screen reader user starts again at the top of the page. This watches the whole document instead:
 * when the focus moves into a dialog from outside, the element it came from is remembered for that dialog; when the
 * dialog leaves the page while nothing has the focus, that element gets it back (if it is still there). A dialog
 * that hands the focus on itself (Mantine's transition, FormModal, a page that focuses a new row) keeps its choice,
 * because the focus is no longer on <body> then.
 */
const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** The button of the menu an item belongs to: the item is gone once the menu closes, its button stays (Mantine's Menu names its dropdown by it). */
function menuButton(el: HTMLElement): HTMLElement | null {
  const id = el.closest('[role="menu"]')?.getAttribute('aria-labelledby');
  return id ? el.ownerDocument.getElementById(id) : null;
}

export function installFocusReturn(doc: Document = document): () => void {
  const openers = new Map<Element, HTMLElement>();
  // the element that had the focus last (the focus can pass through <body> on its way into a dialog)
  let last: HTMLElement | null = null;

  const onFocusIn = (e: FocusEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const previous = last;
    if (target && target !== doc.body) last = target;
    const dialog = target?.closest(DIALOG);
    if (!dialog || openers.has(dialog)) return;
    const related = e.relatedTarget instanceof HTMLElement && e.relatedTarget !== doc.body ? e.relatedTarget : null;
    const from = related ?? previous;
    // from the page (or from another dialog: a dialog opened over a dialog), not from inside the same dialog
    if (from && from.isConnected && !dialog.contains(from)) openers.set(dialog, menuButton(from) ?? from);
  };

  const observer = new MutationObserver(() => {
    for (const [dialog, opener] of openers) {
      if (dialog.isConnected) continue;
      openers.delete(dialog);
      const active = doc.activeElement;
      if (active && active !== doc.body) continue;
      if (!opener.isConnected || opener.closest('[inert], [aria-hidden="true"]')) continue;
      opener.focus({ preventScroll: true });
    }
  });

  doc.addEventListener('focusin', onFocusIn, true);
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true);
    observer.disconnect();
    openers.clear();
  };
}

/**
 * After a row of a list was removed (or moved): the focus goes to the same control of the row now at `index` – the
 * one that took the removed row's place – else of the last row, else to `fallback`, so it is never lost to <body>
 * (WCAG 2.4.3). Runs once the list shows the change (`gone` has left) and a dialog outside `scope` (the confirmation that asked) has
 * left the page – while it closes, its focus trap would take the focus back; disabled and hidden controls are skipped.
 */
export function focusRowControl(
  scope: HTMLElement | null | undefined,
  selector: string,
  index: number,
  fallback?: () => HTMLElement | null | undefined,
  /** The removed row: waited for until it has left the page (the list re-renders after its data came back) */
  gone?: string,
): void {
  const otherDialogOpen = () => [...document.querySelectorAll(DIALOG)].some((d) => !scope || !d.contains(scope));
  const waiting = () => otherDialogOpen() || (!!gone && !!scope?.querySelector(gone));
  const attempt = (framesLeft: number) =>
    requestAnimationFrame(() => {
      if (framesLeft > 0 && waiting()) return attempt(framesLeft - 1);
      const all = [...(scope?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((el) => !el.matches(':disabled') && el.getClientRects().length > 0);
      (all[Math.min(Math.max(index, 0), all.length - 1)] ?? fallback?.())?.focus();
    });
  // at most about a second: a dialog that stays open (another one the person opened) does not hold it back for ever
  attempt(60);
}
