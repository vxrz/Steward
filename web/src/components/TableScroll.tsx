import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The box around a wide table that scrolls sideways (`.table-scroll`). While it does scroll (a phone, a narrow
 * window), keyboard users can reach it: it becomes a focusable region named by `label`, else by its table's
 * `aria-label`, else "Table (scrolls sideways)" (WCAG 2.1.1, axe `scrollable-region-focusable`). While everything
 * fits it is a plain box, with no extra tab stop.
 */
export function TableScroll({ label, children, style, testId }: { label?: string; children: ReactNode; style?: CSSProperties; testId?: string }) {
  const { t } = useTranslation('common');
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [name, setName] = useState<string | undefined>(label);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      setScrolls(el.scrollWidth > el.clientWidth + 1);
      if (!label) setName(el.querySelector('table')?.getAttribute('aria-label') || undefined);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [label]);

  return (
    <div
      ref={ref}
      className="table-scroll"
      style={style}
      data-testid={testId}
      {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-label': label ?? name ?? t('tableScroll') } : {})}
    >
      {children}
    </div>
  );
}
