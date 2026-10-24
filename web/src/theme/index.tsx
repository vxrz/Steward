import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  MantineProvider,
  createTheme,
  defaultVariantColorsResolver,
  parseThemeColor,
  type CSSVariablesResolver,
  type MantineThemeOverride,
  type VariantColorsResolver,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
// Direct imports: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../shared/src/brand';
import { THEME_COLOR_NAMES, THEME_DEFAULTS, generatePalette, themeCssVariables, type PublicTheme } from '../../../shared/src/theme';
import { withBase } from '../basePath';

/**
 * The admin-configured theme (Settings → Appearance), applied to every page
 * including the sign-in page. It comes from the public GET /api/theme (ETag,
 * revalidated), is cached in localStorage so the next visit renders in the
 * right colours at once, and is polled so a change reaches open tabs.
 */
export const DEFAULT_THEME: PublicTheme = { ...THEME_DEFAULTS, logoUrl: null, custom: false };
const CACHE_KEY = 'steward.theme';
const POLL_MS = 60_000;
/** First visit without a cached theme: wait at most this long before rendering with the defaults. */
const FIRST_LOAD_WAIT_MS = 1500;

function readCache(): PublicTheme | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const t = raw ? (JSON.parse(raw) as PublicTheme) : null;
    return t && typeof t.primaryColor === 'string' && typeof t.accentColor === 'string' ? { ...DEFAULT_THEME, ...t } : null;
  } catch {
    return null;
  }
}

function writeCache(t: PublicTheme) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(t));
  } catch {
    /* storage blocked */
  }
}

export async function fetchTheme(): Promise<PublicTheme> {
  // the browser revalidates with If-None-Match (304 when unchanged)
  const res = await fetch(withBase('/api/theme'), { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ...DEFAULT_THEME, ...((await res.json()) as Partial<PublicTheme>) };
}

/** Filled buttons, badges, … of the theme colours use black or white text, whichever reaches WCAG AA (see shared/src/theme.ts). */
const variantColorResolver: VariantColorsResolver = (input) => {
  const out = defaultVariantColorsResolver(input);
  if (input.variant !== 'filled') return out;
  const parsed = parseThemeColor({ color: input.color || input.theme.primaryColor, theme: input.theme });
  if (parsed.isThemeColor && parsed.shade === undefined && (parsed.color === THEME_COLOR_NAMES.primary || parsed.color === THEME_COLOR_NAMES.accent)) {
    return { ...out, color: `var(--sm-${parsed.color}-contrast)` };
  }
  return out;
};

const BASE: MantineThemeOverride = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  variantColorResolver,
  // Icon-only close buttons need an accessible name (screen readers, axe "button-name").
  components: {
    // An explicit default variant makes Mantine resolve the text colour of filled elements through
    // variantColorResolver (without it, a badge without color/variant falls back to white text).
    Badge: { defaultProps: { variant: 'filled' } },
    Button: { defaultProps: { variant: 'filled' } },
    ActionIcon: { defaultProps: { variant: 'filled' } },
    ThemeIcon: { defaultProps: { variant: 'filled' } },
    // the command palette's result list scrolls; make it reachable by keyboard (axe "scrollable-region-focusable")
    SpotlightActionsList: { defaultProps: { viewportProps: { tabIndex: 0 } } },
    TableScrollContainer: { defaultProps: { scrollAreaProps: { viewportProps: { tabIndex: 0 } } } },
  },
};

/** `closeLabel`: accessible name of the close buttons of modals and drawers, in the UI language. */
export function mantineTheme(t: PublicTheme, closeLabel = 'Close') {
  return createTheme({
    ...BASE,
    components: {
      ...BASE.components,
      Modal: { defaultProps: { closeButtonProps: { 'aria-label': closeLabel } } },
      Drawer: { defaultProps: { closeButtonProps: { 'aria-label': closeLabel } } },
    },
    primaryColor: THEME_COLOR_NAMES.primary,
    colors: { [THEME_COLOR_NAMES.primary]: generatePalette(t.primaryColor), [THEME_COLOR_NAMES.accent]: generatePalette(t.accentColor) },
    defaultRadius: t.radius,
  });
}

export function cssVariablesResolver(t: PublicTheme): CSSVariablesResolver {
  const light = themeCssVariables(t, 'light');
  const dark = themeCssVariables(t, 'dark');
  return () => ({ variables: {}, light, dark });
}

const ThemeContext = createContext<PublicTheme>(DEFAULT_THEME);

/** The active theme (colours, display name, logo). */
export const useAppTheme = (): PublicTheme => useContext(ThemeContext);

/** Name in the header, window title and sign-in page: the configured display name or the product name. */
export function useAppName(): string {
  return useAppTheme().appName || BRAND.name;
}

export const themeQueryKey = ['theme'] as const;

/** MantineProvider with the server theme. Renders nothing for a moment on the very first visit (no cached theme yet). */
export function ThemedMantineProvider({ children }: { children: ReactNode }) {
  const [cached] = useState(readCache);
  const q = useQuery({
    queryKey: themeQueryKey,
    queryFn: fetchTheme,
    initialData: cached ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 0,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const [waited, setWaited] = useState(!!cached);
  useEffect(() => {
    if (waited) return;
    const timer = setTimeout(() => setWaited(true), FIRST_LOAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waited]);
  const t = q.data ?? DEFAULT_THEME;
  const { t: tr } = useTranslation('common');
  const closeLabel = tr('close');
  const theme = useMemo(() => mantineTheme(t, closeLabel), [t, closeLabel]);
  const resolver = useMemo(() => cssVariablesResolver(t), [t]);
  useEffect(() => {
    if (q.data) writeCache(q.data);
  }, [q.data]);
  useEffect(() => {
    document.title = t.appName || BRAND.name;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.primaryColor);
  }, [t.appName, t.primaryColor]);
  if (!q.data && !waited && !q.isError) return null;
  return (
    <ThemeContext.Provider value={t}>
      <MantineProvider theme={theme} cssVariablesResolver={resolver} defaultColorScheme={t.colorScheme}>
        {children}
      </MantineProvider>
    </ThemeContext.Provider>
  );
}
