/**
 * Admin-configurable theme (Settings → Appearance): primary and accent colour,
 * default colour scheme, corner radius, app display name and logo.
 *
 * The colour functions are shared by the server (validation, web manifest) and
 * the web UI (Mantine palettes, CSS variables, contrast warnings), so the
 * contrast decisions are made in one place and can be unit tested.
 *
 * No imports: the web imports this file directly (the @sm/shared barrel would
 * pull zod into the first download).
 */

export const THEME_RADII = ['sm', 'md', 'lg'] as const;
export type ThemeRadius = (typeof THEME_RADII)[number];
export const THEME_COLOR_SCHEMES = ['auto', 'light', 'dark'] as const;
export type ThemeColorScheme = (typeof THEME_COLOR_SCHEMES)[number];

/** Header logo: raster images only (SVG can carry scripts). Checked by magic bytes on the server. */
export const THEME_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ThemeLogoType = (typeof THEME_LOGO_TYPES)[number];
export const THEME_LOGO_MAX_BYTES = 512 * 1024;
/** Largest accepted logo width/height in pixels */
export const THEME_LOGO_MAX_PIXELS = 4096;
export const THEME_APP_NAME_MAX = 60;

/** Matches #rgb and #rrggbb */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** The editable part of the theme. */
export interface ThemeInput {
  /** Hex colour of buttons, links, active navigation (#rrggbb) */
  primaryColor: string;
  /** Hex colour of highlights such as counters and badges (#rrggbb) */
  accentColor: string;
  /** Colour scheme for users who have not picked one themselves */
  colorScheme: ThemeColorScheme;
  radius: ThemeRadius;
  /** Shown in the header, window title and sign-in page instead of the product name; '' = product name */
  appName: string;
}

/** Stored theme settings (GET/PUT /api/settings/theme, administrators). */
export interface ThemeSettings extends ThemeInput {
  logo: { mime: ThemeLogoType; size: number; width: number; height: number; sha256: string; updatedAt: string } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/theme: what every browser needs to render the UI (public, cacheable, no secrets). */
export interface PublicTheme extends ThemeInput {
  /** URL of the custom header logo, null = product logo */
  logoUrl: string | null;
  /** false while everything is at the Steward defaults */
  custom: boolean;
}

export const THEME_DEFAULTS: ThemeInput = {
  primaryColor: '#1c7ed6',
  accentColor: '#7950f2',
  colorScheme: 'auto',
  radius: 'md',
  appName: '',
};

export type Palette = [string, string, string, string, string, string, string, string, string, string];

/** Mantine's own palettes for the default colours: the default theme looks exactly as before. */
const KNOWN_PALETTES: Palette[] = [
  ['#e7f5ff', '#d0ebff', '#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#228be6', '#1c7ed6', '#1971c2', '#1864ab'],
  ['#f3f0ff', '#e5dbff', '#d0bfff', '#b197fc', '#9775fa', '#845ef7', '#7950f2', '#7048e8', '#6741d9', '#5f3dc4'],
];

// ---------------------------------------------------------------------------
// colour conversion

type Rgb = [number, number, number];

/** "#abc" / "#aabbcc" → "#aabbcc" (lower case); null when not a hex colour. */
export function normalizeHex(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!HEX_COLOR.test(s)) return null;
  const h = s.slice(1).toLowerCase();
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
}

function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex);
  if (!h) throw new Error(`Not a hex colour: ${hex}`);
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB → OKLCH (L 0…1, C ≥ 0, H degrees) */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb;
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.sqrt(A * A + B * B), h: h < 0 ? h + 360 : h };
}

function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → hex; chroma is reduced (same lightness and hue) until the colour fits into sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  const L = Math.min(1, Math.max(0, l));
  let rgb = oklchToLinear(L, c, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear(L, lo, h);
  }
  return rgbToHex(rgb.map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as Rgb);
}

// ---------------------------------------------------------------------------
// WCAG contrast

/** Relative luminance (WCAG 2.x, same formula as axe-core). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio 1…21 */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** `color` with `alpha` over an opaque background, as the browser renders it. */
export function composite(color: string, alpha: number, background: string): string {
  const f = hexToRgb(color);
  const bg = hexToRgb(background);
  return rgbToHex(f.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as Rgb);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG 2.1 AA for normal text. */
export const AA_TEXT = 4.5;
/** Target used when choosing colours: a little above AA so rounding never tips a pair below it. */
const TARGET = 4.6;

// ---------------------------------------------------------------------------
// palettes

/**
 * Ten shades (0 = lightest … 9 = darkest) from one colour, perceptually spaced in
 * OKLCH: the colour itself is shade 6 (Mantine's primary shade in the light scheme),
 * lighter shades approach white with less chroma, darker ones keep the hue.
 * Steward's default colours return Mantine's original palettes.
 */
export function generatePalette(input: string): Palette {
  const hex = normalizeHex(input);
  if (!hex) throw new Error(`Not a hex colour: ${input}`);
  const known = KNOWN_PALETTES.find((p) => p[6] === hex || p[7] === hex);
  if (known) return [...known] as Palette;
  const { l, c, h } = hexToOklch(hex);
  const top = Math.max(0.97, l + 0.02);
  // share of the way from the lightest shade (0) to the colour (6)
  const toColor = [0, 0.1, 0.25, 0.47, 0.68, 0.85];
  const chroma = [0.12, 0.25, 0.48, 0.72, 0.88, 0.96];
  const darker = [0.07, 0.14, 0.22];
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(oklchToHex(top + (l - top) * toColor[i]!, c * chroma[i]!, h));
  out.push(hex);
  for (let i = 0; i < 3; i++) out.push(oklchToHex(l * (1 - darker[i]!), c * (1 - 0.04 * (i + 1)), h));
  return out as Palette;
}

/** Moves the lightness (OKLCH) of `hex` towards dark or light until it reaches `target` against every background. */
function adjustForContrast(hex: string, backgrounds: string[], direction: 'darker' | 'lighter', target = TARGET): string {
  const ok = (x: string) => backgrounds.every((bg) => contrastRatio(x, bg) >= target);
  if (ok(hex)) return hex;
  const { l, c, h } = hexToOklch(hex);
  for (let i = 1; i <= 100; i++) {
    const nl = direction === 'darker' ? l - (l * i) / 100 : l + ((1 - l) * i) / 100;
    const x = oklchToHex(nl, c, h);
    if (ok(x)) return x;
  }
  return direction === 'darker' ? '#000000' : '#ffffff';
}

// ---------------------------------------------------------------------------
// colours per scheme

export type ColorSchemeName = 'light' | 'dark';

/** Page surfaces the theme colours have to stay readable on (Mantine defaults). */
export const SURFACES: Record<ColorSchemeName, string[]> = {
  // body, striped/hovered rows
  light: ['#ffffff', '#f8f9fa'],
  // body (dark-7), cards/inputs (dark-6)
  dark: ['#242424', '#2e2e2e'],
};
/** Opacity of the "light" variant background (badges, alerts, active navigation): Mantine 0.1 / 0.15 */
const LIGHT_ALPHA: Record<ColorSchemeName, number> = { light: 0.1, dark: 0.15 };

export interface SchemeColors {
  /** Background of filled buttons and badges */
  filled: string;
  filledHover: string;
  /** Text on `filled`: black or white, whichever reaches AA (auto contrast) */
  onFilled: '#000000' | '#ffffff';
  onFilledRatio: number;
  /** Links, light/outline/subtle variants, active navigation: a shade that reaches AA on every surface */
  text: string;
  textRatio: number;
  /** Background of light variants */
  light: string;
  lightHover: string;
  outlineHover: string;
  /** Lowest contrast of `filled` against the page surfaces (non-text contrast, 3:1 recommended) */
  surfaceRatio: number;
}

const WHITE = '#ffffff';
const BLACK = '#000000';

/**
 * Picks the shades of a palette for one colour scheme so that text stays at WCAG AA:
 *  - filled: white text on the colour (or up to two shades darker) like Mantine's defaults,
 *    otherwise the colour itself with black text (bright colours such as yellow);
 *  - text: the first shade from the colour towards dark (light scheme) or light (dark scheme)
 *    that reaches AA on every surface, including the tinted light-variant background;
 *    computed when no shade of the palette does.
 */
export function schemeColors(palette: Palette, scheme: ColorSchemeName): SchemeColors {
  const surfaces = SURFACES[scheme];
  const tint = (bg: string) => composite(palette[6], LIGHT_ALPHA[scheme], bg);
  const textBackgrounds = [...surfaces, ...surfaces.map(tint)];

  // filled background + text on it. In the dark scheme the button also has to stand out from the page
  // (a very dark colour would disappear), so shades with too little contrast to the surfaces come last.
  const standsOut = (i: number) => scheme === 'light' || Math.min(...surfaces.map((bg) => contrastRatio(palette[i]!, bg))) >= 2;
  const withWhite = (scheme === 'light' ? [6, 7, 8] : [8, 9, 7, 6]).filter((i) => contrastRatio(WHITE, palette[i]!) >= TARGET);
  const withBlack = (scheme === 'light' ? [6, 5, 4] : [6, 5, 4, 3, 2, 7]).filter((i) => contrastRatio(BLACK, palette[i]!) >= TARGET);
  const candidates: [number, SchemeColors['onFilled']][] = [
    ...withWhite.filter(standsOut).map((i) => [i, WHITE] as [number, SchemeColors['onFilled']]),
    ...withBlack.filter(standsOut).map((i) => [i, BLACK] as [number, SchemeColors['onFilled']]),
    ...withWhite.map((i) => [i, WHITE] as [number, SchemeColors['onFilled']]),
    ...withBlack.map((i) => [i, BLACK] as [number, SchemeColors['onFilled']]),
  ];
  const filledIndex: number | undefined = candidates[0]?.[0];
  let onFilled: SchemeColors['onFilled'] = candidates[0]?.[1] ?? WHITE;
  let filled: string;
  if (filledIndex === undefined) {
    // (only for unusual palettes) the colour itself, darkened or lightened until one text colour works
    const base = palette[6];
    const whiteText = contrastRatio(WHITE, base) >= contrastRatio(BLACK, base);
    onFilled = whiteText ? WHITE : BLACK;
    filled = adjustForContrast(base, [onFilled], whiteText ? 'darker' : 'lighter');
  } else filled = palette[filledIndex]!;
  const hoverCandidates = filledIndex === undefined ? [] : [filledIndex + 1, filledIndex - 1].filter((i) => i >= 0 && i <= 9);
  const hoverIndex = hoverCandidates.find((i) => contrastRatio(onFilled, palette[i]!) >= AA_TEXT);
  const filledHover = hoverIndex === undefined ? filled : palette[hoverIndex]!;

  // text colour
  const order = scheme === 'light' ? [6, 7, 8, 9] : [4, 3, 2, 1, 0];
  const passes = (x: string) => textBackgrounds.every((bg) => contrastRatio(x, bg) >= TARGET);
  const found = order.map((i) => palette[i]!).find(passes);
  const text = found ?? adjustForContrast(palette[order[order.length - 1]!]!, textBackgrounds, scheme === 'light' ? 'darker' : 'lighter');

  const lightBase = palette[6];
  return {
    filled,
    filledHover,
    onFilled,
    onFilledRatio: round2(contrastRatio(onFilled, filled)),
    text,
    textRatio: round2(Math.min(...textBackgrounds.map((bg) => contrastRatio(text, bg)))),
    light: rgba(lightBase, LIGHT_ALPHA[scheme]),
    lightHover: rgba(lightBase, scheme === 'light' ? 0.12 : 0.2),
    outlineHover: rgba(lightBase, 0.05),
    surfaceRatio: round2(Math.min(...surfaces.map((bg) => contrastRatio(filled, bg)))),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// the whole theme

/** Palette names in the Mantine theme */
export const THEME_COLOR_NAMES = { primary: 'brand', accent: 'accent' } as const;

export interface ResolvedThemeColor {
  input: string;
  palette: Palette;
  light: SchemeColors;
  dark: SchemeColors;
}

export function resolveThemeColor(hex: string): ResolvedThemeColor {
  const palette = generatePalette(hex);
  return { input: normalizeHex(hex)!, palette, light: schemeColors(palette, 'light'), dark: schemeColors(palette, 'dark') };
}

/**
 * CSS custom properties for one colour scheme: Mantine's colour variables of the
 * primary ("brand") and accent palettes, the primary-colour aliases, the link
 * colour, the default radius and --sm-<name>-contrast (text on filled elements).
 * Used for the whole page (Mantine cssVariablesResolver) and for the live preview
 * in Settings (style attribute of the preview container).
 */
export function themeCssVariables(theme: Pick<ThemeInput, 'primaryColor' | 'accentColor'>, scheme: ColorSchemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  const add = (name: string, c: ResolvedThemeColor, primary: boolean) => {
    const s = c[scheme];
    const set = (suffix: string, value: string) => {
      vars[`--mantine-color-${name}-${suffix}`] = value;
      if (primary) vars[`--mantine-primary-color-${suffix}`] = value;
    };
    c.palette.forEach((shade, i) => set(String(i), shade));
    set('filled', s.filled);
    set('filled-hover', s.filledHover);
    set('light', s.light);
    set('light-hover', s.lightHover);
    set('light-color', s.text);
    vars[`--mantine-color-${name}-text`] = s.text;
    vars[`--mantine-color-${name}-outline`] = s.text;
    vars[`--mantine-color-${name}-outline-hover`] = s.outlineHover;
    vars[`--sm-${name}-contrast`] = s.onFilled;
    if (primary) {
      vars['--mantine-primary-color-contrast'] = s.onFilled;
      vars['--mantine-color-anchor'] = s.text;
    }
  };
  add(THEME_COLOR_NAMES.primary, resolveThemeColor(theme.primaryColor), true);
  add(THEME_COLOR_NAMES.accent, resolveThemeColor(theme.accentColor), false);
  return vars;
}

/** Notes for the settings page: where a chosen colour had to be adjusted to reach AA. */
export interface ThemeContrastNote {
  color: 'primary' | 'accent';
  /** 'both': the same adjustment in the light and the dark scheme */
  scheme: ColorSchemeName | 'both';
  kind: 'textAdjusted' | 'darkTextOnFilled' | 'filledAdjusted' | 'lowSurfaceContrast';
  /** Colour used instead (text) or the filled background */
  used: string;
  ratio: number;
}

export function themeContrastNotes(theme: Pick<ThemeInput, 'primaryColor' | 'accentColor'>): ThemeContrastNote[] {
  const notes: ThemeContrastNote[] = [];
  for (const color of ['primary', 'accent'] as const) {
    const hex = color === 'primary' ? theme.primaryColor : theme.accentColor;
    // the Steward defaults are Mantine's palettes with their usual shades: nothing to explain
    if (normalizeHex(hex) === (color === 'primary' ? THEME_DEFAULTS.primaryColor : THEME_DEFAULTS.accentColor)) continue;
    const c = resolveThemeColor(hex);
    for (const scheme of ['light', 'dark'] as const) {
      const s = c[scheme];
      if (s.onFilled === BLACK) notes.push({ color, scheme, kind: 'darkTextOnFilled', used: s.filled, ratio: s.onFilledRatio });
      else if (s.filled !== c.input && scheme === 'light') notes.push({ color, scheme, kind: 'filledAdjusted', used: s.filled, ratio: s.onFilledRatio });
      // (the dark scheme always uses a lighter shade for text, like Mantine)
      if (scheme === 'light' && s.text !== c.input && contrastRatio(c.input, SURFACES[scheme][0]!) < AA_TEXT)
        notes.push({ color, scheme, kind: 'textAdjusted', used: s.text, ratio: s.textRatio });
      if (s.surfaceRatio < (scheme === 'light' ? 1.5 : 2)) notes.push({ color, scheme, kind: 'lowSurfaceContrast', used: s.filled, ratio: s.surfaceRatio });
    }
  }
  // one note instead of two when both schemes make the same adjustment
  return notes.filter((n, i) => {
    if (n.scheme !== 'dark') return true;
    const twin = notes.find((m, j) => j < i && m.scheme === 'light' && m.color === n.color && m.kind === n.kind && m.used === n.used);
    if (twin) twin.scheme = 'both';
    return !twin;
  });
}

/** Normalises and checks a theme input; returns the problems (English) – empty when valid. */
export function themeProblems(t: Partial<ThemeInput>): string[] {
  const p: string[] = [];
  if (t.primaryColor !== undefined && !normalizeHex(t.primaryColor)) p.push('primaryColor: use a hex colour like #1c7ed6');
  if (t.accentColor !== undefined && !normalizeHex(t.accentColor)) p.push('accentColor: use a hex colour like #7950f2');
  if (t.colorScheme !== undefined && !(THEME_COLOR_SCHEMES as readonly string[]).includes(t.colorScheme))
    p.push(`colorScheme: one of ${THEME_COLOR_SCHEMES.join(', ')}`);
  if (t.radius !== undefined && !(THEME_RADII as readonly string[]).includes(t.radius)) p.push(`radius: one of ${THEME_RADII.join(', ')}`);
  if (t.appName !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f<>]/.test(t.appName)) p.push('appName: no control characters or angle brackets');
    if (t.appName.trim().length > THEME_APP_NAME_MAX) p.push(`appName: at most ${THEME_APP_NAME_MAX} characters`);
  }
  return p;
}

export function isDefaultTheme(t: ThemeInput, hasLogo: boolean): boolean {
  return (
    !hasLogo &&
    normalizeHex(t.primaryColor) === THEME_DEFAULTS.primaryColor &&
    normalizeHex(t.accentColor) === THEME_DEFAULTS.accentColor &&
    t.colorScheme === THEME_DEFAULTS.colorScheme &&
    t.radius === THEME_DEFAULTS.radius &&
    !t.appName.trim()
  );
}
